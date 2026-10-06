"""Temporary owner-only #319 two-CPU comparison; source remains immutable."""
import base64, datetime, gzip, hashlib, io, json, os, re, shutil, signal, subprocess, sys, tarfile, time
from pathlib import Path

HEAD = "c9f0a9c2c6bd73841246303ae75056aceffdb3d5"
TREE = "5092dc1d14640caf5c98990cd87bc3a4959c4a18"
LOCK = "3abd4922490a95cf538c52e16e16fccc739b9c277d4217e21d0064efe9acd797"
ROOT = Path(sys.argv[1]).resolve()
ARTIFACTS = Path(os.environ["RUNNER_TEMP"]) / "319-two-cpu-evidence"
ORDER = ("serial", "parallel2", "parallel2", "serial")
BUDGET = 1500

def write(filename, value):
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_text(json.dumps(value, indent=2) + "\n")

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

def sha(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()

def live_group_members(group):
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[2]) == group and fields[0] not in {"Z", "X"}:
            members.append(int(entry.name))
    return sorted(members)


def stop_group(group):
    # This proves only the wrapper group stopped. Detached descendants can escape
    # that group, so failed samples must end the isolated hosted job immediately.
    cleanup = {"group": group, "scope": "wrapper-process-group-only",
               "remainingLivePids": [], "processGroupVerified": False,
               "detachedDescendantsVerified": False}
    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while live_group_members(group) and time.monotonic() < deadline:
        time.sleep(0.05)
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while live_group_members(group) and time.monotonic() < deadline:
        time.sleep(0.05)
    cleanup["remainingLivePids"] = live_group_members(group)
    cleanup["processGroupVerified"] = not cleanup["remainingLivePids"]
    return cleanup


def abort_collection(directory, result, log, stderr, reason):
    result.update({"completedGate": False, "collectionAborted": True,
                   "abortReason": reason, "runnerTeardownRequired": True,
                   "runnerTeardownObserved": False, "detachedDescendantsVerified": False})
    write(directory / "result.json", result)
    write(ARTIFACTS / "summary.json", {"collectionComplete": False, "allGatesPassed": False,
          "stoppedAfterSample": directory.name, "pairs": [], "abortReason": reason,
          "isolationBoundary": "dedicated GitHub-hosted job VM",
          "runnerTeardownRequired": True, "runnerTeardownObserved": False,
          "detachedDescendantsVerified": False})
    print(json.dumps(result, indent=2), flush=True)
    print("BEGIN_SAMPLE_STDOUT " + directory.name + "\n" + log + "\nEND_SAMPLE_STDOUT", flush=True)
    print("BEGIN_SAMPLE_STDERR " + directory.name + "\n" + stderr + "\nEND_SAMPLE_STDERR", flush=True)
    # Only file/log evidence is retained after this point; no source probes,
    # coverage diagnostics or later samples may run on this VM.
    raise SystemExit(1)


def execute(directory, command, env, budget):
    directory.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    timed_out = False
    interrupted = False
    samples = []
    group_cleanup = None
    previous_handlers = {}

    def defer_cancellation(_signal, _frame):
        nonlocal interrupted
        interrupted = True

    try:
        # Install before starting the child; repeated cancellation records intent
        # without aborting owned-group cleanup or evidence persistence.
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, defer_cancellation)
        with (directory / "stdout.log").open("w") as out, (directory / "stderr.log").open("w") as err:
            process = subprocess.Popen(["/usr/bin/time", "-v", *command], cwd=ROOT, env=env,
                                       stdout=out, stderr=err, start_new_session=True)

            def leader_exited():
                # WNOWAIT retains the leader's PID until all owned-group signaling ends.
                return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

            def wait_for_leader(seconds):
                deadline = time.monotonic() + seconds
                while not leader_exited():
                    if interrupted:
                        return False
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    time.sleep(min(0.05, remaining))
                return True

            try:
                while not leader_exited() and not interrupted:
                    elapsed = time.monotonic() - started
                    if elapsed >= budget:
                        timed_out = True
                        break
                    samples.append({"seconds": elapsed, "load": os.getloadavg()})
                    complete = wait_for_leader(min(15, budget - elapsed))
                    print(json.dumps({"sample": directory.name, "elapsedSeconds": round(time.monotonic() - started, 1),
                                      "running": not complete}), flush=True)
            except (KeyboardInterrupt, InterruptedError):
                interrupted = True
            finally:
                if timed_out or interrupted or live_group_members(process.pid):
                    # Never poll/wait (reap) before signaling: a dead leader may still
                    # have live descendants, and its retained PID prevents group reuse.
                    group_cleanup = stop_group(process.pid)
                # A hard-limit survivor must not turn cleanup into an unbounded wait.
                # No owned-group signal is sent after this final reap.
                if leader_exited():
                    process.wait()
        log = (directory / "stdout.log").read_text()
        result = {"command": command, "processGroup": process.pid, "exitCode": process.returncode, "outerBudgetSeconds": budget,
                  "outerBudgetExceeded": timed_out, "interrupted": interrupted, "ownedGroupCleanup": group_cleanup,
                  "detachedDescendantsVerified": False, "runnerTeardownObserved": False,
                  "runnerTeardownRequired": timed_out or interrupted or group_cleanup is not None or process.returncode != 0,
                  "elapsedSeconds": time.monotonic() - started, "samples": samples,
                  "summaries": re.findall(r"^\s*\d+ (?:passing|pending|failing)[^\n]*", log, re.M),
                  "timeoutLines": [line for line in log.splitlines() if "Timeout of" in line]}
        write(directory / "result.json", result)
        return result, log
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)



def source_unchanged():
    return git("rev-parse", "HEAD") == HEAD and git("rev-parse", "HEAD^{tree}") == TREE and not git("status", "--porcelain") and sha(ROOT / "package-lock.json") == LOCK

def runtime(env):
    return json.loads(subprocess.check_output(["node", "-p", 'JSON.stringify({node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,availableParallelism:require("node:os").availableParallelism(),mocha:require("mocha/package.json").version,c8:require("c8/package.json").version})'], cwd=ROOT, env=env, text=True))

def bundle():
    # Logs retain compact evidence without creating billable artifact storage.
    memory = io.BytesIO()
    with tarfile.open(fileobj=memory, mode="w:gz") as archive:
        archive.add(ARTIFACTS, arcname="319-two-cpu-evidence")
    data = memory.getvalue()
    if len(data) > 20 * 1024 * 1024:
        raise RuntimeError("Compact log evidence exceeds the 20MiB cap")
    print("BEGIN_319_EVIDENCE_TGZ " + hashlib.sha256(data).hexdigest(), flush=True)
    encoded = base64.b64encode(data).decode("ascii")
    for offset in range(0, len(encoded), 1024):
        print(encoded[offset:offset+1024], flush=True)
    print("END_319_EVIDENCE_TGZ", flush=True)

def main():
    assert sys.platform == "linux" and os.getuid() != 0
    assert os.environ["GITHUB_ACTIONS"] == "true" and os.environ["RUNNER_ENVIRONMENT"] == "github-hosted"
    assert os.environ["GITHUB_REPOSITORY"] == "JBallin/ballin-scripts"
    assert os.environ["GITHUB_REF"] == "refs/heads/experiment/319-two-cpu-evidence"
    assert os.environ["GITHUB_ACTOR"] == "JBallin" and os.environ["GITHUB_RUN_ATTEMPT"] == "1"
    assert source_unchanged()
    package = json.loads((ROOT / "package.json").read_text())
    assert package["scripts"]["test:unit"] == "mocha --parallel --jobs=2"
    permitted = sorted(os.sched_getaffinity(0))
    assert len(permitted) >= 2
    cpus = set(permitted[:2])
    os.sched_setaffinity(0, cpus)
    assert os.sched_getaffinity(0) == cpus
    ARTIFACTS.mkdir()
    env = dict(os.environ)
    for key in ["NODE_OPTIONS", "NODE_V8_COVERAGE", "MOCHA_OPTIONS", "MOCHA_WORKER_ID", "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE", "GITHUB_TOKEN", "GH_TOKEN"]:
        env.pop(key, None)
    info = runtime(env)
    assert info["node"] == "v24.21.0" and info["availableParallelism"] == 2
    assert info["mocha"] == "11.7.6" and info["c8"] == "12.0.0"
    write(ARTIFACTS / "preflight.json", {"commit": HEAD, "tree": TREE, "lockSha256": LOCK, "runtime": info, "affinity": sorted(cpus), "control": "Two-CPU inherited affinity on the standard public Ubuntu runner; not a reproduction of cgroup cpu.max timing.", "order": ORDER, "sampleBudgetSeconds": BUDGET, "gateCountCap": 4,
          "isolationBoundary": "dedicated GitHub-hosted job VM",
          "detachedDescendantsVerified": False,
          "abortPolicy": "First unsafe or failed gate stops collection; hosted VM teardown is required, not observed by this driver."})
    rows = []
    for index, mode in enumerate(ORDER, 1):
        assert source_unchanged() and runtime(env) == info and os.sched_getaffinity(0) == cpus
        directory = ARTIFACTS / f"{index:02d}-{mode}"
        directory.mkdir()
        temporary = Path(os.environ["RUNNER_TEMP"]) / f"319-two-cpu-fixtures-{index}"
        temporary.mkdir()
        sample_env = {**env, "TMPDIR": str(temporary)}
        coverage = ROOT / "coverage"
        assert not coverage.is_symlink()
        if coverage.exists():
            shutil.rmtree(coverage)
        flag = "--no-parallel" if mode == "serial" else "--parallel"
        # Pass one mode flag through both nested npm scripts into the existing Mocha command.
        command = ["npm", "test", "--", "--", "--", flag]
        write(directory / "provenance.json", {"commit": HEAD, "tree": TREE, "lockSha256": LOCK, "runtime": info, "affinity": sorted(cpus), "mode": mode, "command": command})
        result, log = execute(directory, command, sample_env, BUDGET)
        stderr = (directory / "stderr.log").read_text()
        result["mode"] = mode
        result["completedStages"] = re.findall(r"^> ballin-scripts@\S+ (\S+)\s*$", log, re.M)
        result["forwardingVerified"] = "mocha --parallel --jobs=2 " + flag in log
        result["passingCounts"] = [int(value) for value in re.findall(r"^\s*(\d+) passing", log, re.M)]
        terminal_gate_passed = result["exitCode"] == 0 and result["ownedGroupCleanup"] is None and not result["outerBudgetExceeded"] and not result["interrupted"] and result["passingCounts"] == [1842] and not result["timeoutLines"] and not re.search(r"^\s*[1-9]\d* (pending|failing)", log, re.M) and result["completedStages"] == ["test", "lint", "typecheck", "typecheck:analytics-worker", "test:coverage", "test:unit"] and result["forwardingVerified"]
        if not terminal_gate_passed:
            abort_collection(directory, result, log, stderr, "Unsafe, incomplete or failed test gate; discard the hosted job VM.")
        result["runtime"] = runtime(env)
        result["sourceUnchanged"] = source_unchanged()
        result["affinity"] = sorted(os.sched_getaffinity(0))
        result["temporaryEntries"] = sorted(item.name for item in temporary.iterdir())
        result["fixtureLeaks"] = [name for name in result["temporaryEntries"] if name != "node-compile-cache"]
        result["completedGate"] = not result["fixtureLeaks"] and result["sourceUnchanged"] and result["runtime"] == info and result["affinity"] == sorted(cpus)
        if not result["completedGate"]:
            abort_collection(directory, result, log, stderr, "Fixture leak or source/runtime/affinity drift; discard the hosted job VM.")
        write(directory / "result.json", result)
        # Completed passing gates retain their original logs and strict coverage outcome.
        print(json.dumps(result, indent=2), flush=True)
        print("BEGIN_SAMPLE_STDOUT " + directory.name + "\n" + log + "\nEND_SAMPLE_STDOUT", flush=True)
        print("BEGIN_SAMPLE_STDERR " + directory.name + "\n" + stderr + "\nEND_SAMPLE_STDERR", flush=True)
        for name in ["/proc/self/cgroup", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu.stat"]:
            file = Path(name)
            if file.exists():
                write(directory / (file.name + ".json"), {"path": name, "content": file.read_text()})
        raw = coverage / "tmp"
        if raw.exists() and any(raw.glob("coverage-*.json")):
            diagnostic_command = ["node", "node_modules/c8/bin/c8.js", "report", "--check-coverage=false", "--reporter=json", "--reporter=json-summary"]
            with (directory / "diagnostic-report.log").open("w") as diagnostic_log:
                captured = subprocess.run(diagnostic_command, cwd=ROOT, env=sample_env, stdout=diagnostic_log, stderr=subprocess.STDOUT, timeout=120)
            write(directory / "diagnostic-report.json", {"command": diagnostic_command, "exitCode": captured.returncode, "scope": "Post-gate evidence only; original full gate retains every threshold."})
            assert captured.returncode == 0
        for name in ["coverage-final.json", "coverage-summary.json"]:
            if (coverage / name).exists():
                shutil.copy2(coverage / name, directory / name)
        rows.append(result)
        shutil.rmtree(temporary)
    pairs = []
    for start in [0, 2]:
        serial = next(row for row in rows[start:start+2] if row["mode"] == "serial")
        parallel = next(row for row in rows[start:start+2] if row["mode"] == "parallel2")
        pairs.append({"serialSeconds": serial["elapsedSeconds"], "parallelSeconds": parallel["elapsedSeconds"], "serialCompletedGate": serial["completedGate"], "parallelCompletedGate": parallel["completedGate"], "reductionPercent": (100 * (serial["elapsedSeconds"] - parallel["elapsedSeconds"]) / serial["elapsedSeconds"]) if serial["completedGate"] and parallel["completedGate"] else None})
    summary = {"collectionComplete": True, "pairs": pairs, "allGatesPassed": all(row["completedGate"] for row in rows), "detachedDescendantsVerified": False, "runnerTeardownObserved": False,
               "interpretation": "Only fully passing gates can continue. Any failure stops collection and requires hosted VM teardown. Affinity results do not independently refute a different cgroup-quota or Node24.15 environment."}
    write(ARTIFACTS / "summary.json", summary)
    print("BENCHMARK_SUMMARY " + json.dumps(summary), flush=True)
    if not summary["allGatesPassed"]:
        raise SystemExit(1)

if __name__ == "__main__":
    try:
        main()
    finally:
        if ARTIFACTS.exists():
            bundle()
