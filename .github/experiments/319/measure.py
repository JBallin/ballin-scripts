"""Temporary #319 CI experiment. One dispatch, six samples, no retries."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import statistics
import subprocess
import sys
import tarfile
import time
import urllib.request

BASE = "a4f151a7c9216e2c6c02398fe68bc62ae3507b54"
LOCK = "3abd4922490a95cf538c52e16e16fccc739b9c277d4217e21d0064efe9acd797"
ORDER = ("serial", "parallel2", "parallel2", "serial", "serial", "parallel2")
ROOT = Path.cwd().resolve()
TOOLS = ROOT / ".github/experiments/319"
ARTIFACTS = Path(os.environ["CI_319_ARTIFACTS"]).resolve()
FIXTURES = Path(os.environ["CI_319_FIXTURES"]).resolve()
assert FIXTURES.parent == Path(os.environ["RUNNER_TEMP"]).resolve()
assert FIXTURES.name == "ballin-319-ci-fixtures"


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
                if timed_out or interrupted:
                    # Never poll/wait (reap) before signaling: a dead leader may still
                    # have live descendants, and its retained PID prevents group reuse.
                    group_cleanup = {"group": process.pid, "remainingLivePids": [], "verified": False}
                    try:
                        try:
                            os.killpg(process.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        deadline = time.monotonic() + 5
                        while live_group_members(process.pid) and time.monotonic() < deadline:
                            time.sleep(0.05)
                    except (KeyboardInterrupt, InterruptedError):
                        interrupted = True
                    finally:
                        # KILL is independent of whether the time/command leader exited.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    deadline = time.monotonic() + 5
                    while live_group_members(process.pid) and time.monotonic() < deadline:
                        time.sleep(0.05)
                    group_cleanup["remainingLivePids"] = live_group_members(process.pid)
                    group_cleanup["verified"] = not group_cleanup["remainingLivePids"]
                # A hard-limit survivor must not turn cleanup into an unbounded wait.
                # No owned-group signal is sent after this final reap.
                if leader_exited():
                    process.wait()
        log = (directory / "stdout.log").read_text()
        result = {"command": command, "exitCode": process.returncode, "outerBudgetSeconds": budget,
                  "outerBudgetExceeded": timed_out, "interrupted": interrupted, "ownedGroupCleanup": group_cleanup,
                  "elapsedSeconds": time.monotonic() - started, "samples": samples,
                  "summaries": re.findall(r"^\s*\d+ (?:passing|pending|failing)[^\n]*", log, re.M),
                  "timeoutLines": [line for line in log.splitlines() if "Timeout of" in line]}
        write(directory / "result.json", result)
        return result, log
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def preflight():
    assert sys.platform == "linux" and os.getuid() != 0
    assert os.environ["GITHUB_REPOSITORY"] == "JBallin/ballin-scripts"
    assert os.environ["GITHUB_REF"] == "refs/heads/experiment/319-ci-comparison"
    assert os.environ["GITHUB_RUN_ATTEMPT"] == "1", "Reruns are outside the experiment cap"
    assert git("rev-parse", "HEAD") == os.environ["GITHUB_SHA"]
    # Only the first manual CI dispatch on this dedicated branch may measure.
    # A duplicate dispatch or rerun must not spend a second six-sample budget.
    endpoint = os.environ["GITHUB_API_URL"] + "/repos/JBallin/ballin-scripts/actions/runs?branch=experiment%2F319-ci-comparison&event=workflow_dispatch&per_page=100"
    request = urllib.request.Request(endpoint, headers={"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                                     "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        run_history = json.load(response)
    assert run_history["total_count"] <= 100, "Ambiguous branch run history"
    runs = [run for run in run_history["workflow_runs"] if run["path"].split("@")[0] == ".github/workflows/ci.yml"]
    assert runs and min(runs, key=lambda run: run["run_number"])["id"] == int(os.environ["GITHUB_RUN_ID"])
    assert not git("status", "--porcelain"), "Checkout must start clean"
    assert sha(ROOT / "package-lock.json") == LOCK
    allowed = {".github/workflows/ci.yml", "test/setup.ts",
               ".github/experiments/319/measure.py", ".github/experiments/319/coverage.cjs",
               ".github/experiments/319/reuse-observer.cjs"}
    changed = set(git("diff", "--name-only", BASE, "HEAD").splitlines())
    assert changed <= allowed and "test/setup.ts" in changed
    setup_patch = subprocess.check_output(["git", "diff", BASE, "HEAD", "--", "test/setup.ts"], cwd=ROOT)
    assert hashlib.sha256(setup_patch).hexdigest() == "2a831f6163dfc69a08e409e2e9c11db590e3d37778c6be4f27a9c6faa949085e"
    for key in ["NODE_OPTIONS", "NODE_V8_COVERAGE", "MOCHA_OPTIONS", "MOCHA_WORKER_ID",
                "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE"]:
        assert not os.environ.get(key), f"Unexpected inherited {key}"
    runtime = json.loads(subprocess.check_output(["node", "-p", "JSON.stringify({node:process.version,v8:process.versions.v8,arch:process.arch,cpus:require('node:os').availableParallelism(),mocha:require('mocha/package.json').version,c8:require('c8/package.json').version})"], cwd=ROOT, text=True))
    assert runtime["node"] == "v24.21.0" and runtime["v8"] == "13.6.233.17-node.53"
    assert runtime["mocha"] == "11.7.6" and runtime["c8"] == "12.0.0"
    assert runtime["arch"] == "x64" and runtime["cpus"] >= 2
    status = Path("/proc/self/status").read_text()
    umask = re.search(r"^Umask:\s+(\d+)$", status, re.M).group(1)
    assert int(umask, 8) == 0o022, "Unexpected runner umask; stop rather than change it"
    quota_file = Path("/sys/fs/cgroup/cpu.max")
    quota = quota_file.read_text().strip() if quota_file.exists() else None
    if quota and not quota.startswith("max "):
        limit, period = map(int, quota.split())
        assert limit / period >= 2
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    assert not (ARTIFACTS / "preflight.json").exists(), "Do not overwrite an experiment"
    FIXTURES.mkdir(parents=True, exist_ok=True)
    write(ARTIFACTS / "preflight.json", {"base": BASE, "commit": git("rev-parse", "HEAD"),
          "tree": git("rev-parse", "HEAD^{tree}"), "lockSha256": LOCK, "runtime": runtime,
          "umask": umask, "cpuQuota": quota, "memory": Path("/proc/meminfo").read_text(),
          "runnerImage": {key: os.environ.get(key) for key in ["ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"]},
          "order": ORDER, "measurementCap": 6, "commandBudgetSeconds": 900,
          "firstAndOnlyAuthorizedRun": os.environ["GITHUB_RUN_ID"],
          "toolSha256": {filename.name: sha(filename) for filename in TOOLS.iterdir() if filename.is_file()}})


def child_env(mode, directory):
    env = dict(os.environ)
    env["MOCHA_OPTIONS"] = "--no-parallel" if mode == "serial" else "--parallel --jobs=2"
    temporary = FIXTURES / directory.name
    temporary.mkdir()
    env["TMPDIR"] = str(temporary)
    return env, temporary


def cleanup(temporary, directory):
    leftovers = list(temporary.iterdir())
    # npm enables its own compile cache even with NODE_COMPILE_CACHE unset.
    cache = temporary / "node-compile-cache"
    unexpected = [item for item in leftovers if item != cache]
    if cache in leftovers:
        assert cache.is_dir() and not cache.is_symlink(), "Unexpected npm cache path"
    write(directory / "cleanup.json", {
        "remainingTemporaryPaths": [str(item) for item in leftovers],
        "unexpectedFixturePaths": [str(item) for item in unexpected],
        "ownedNpmCompileCache": str(cache) if cache in leftovers else None,
    })
    # Preserve leak evidence, then remove only this experiment's scratch root.
    import shutil
    shutil.rmtree(temporary)
    assert not unexpected, "Fixture cleanup did not complete"


def probe():
    directory = ARTIFACTS / "probe"
    env, temporary = child_env("parallel2", directory)
    env["PARALLEL_PROBE_LOG"] = str(directory / "events.jsonl")
    command = ["npm", "run", "test:unit", "--", "test/environment.test.ts", "test/config.test.ts",
               "test/backup_status.test.ts", "test/analytics.test.ts", "--require", str(TOOLS / "reuse-observer.cjs")]
    try:
        result, log = execute(directory, command, env, 180)
        assert result["exitCode"] == 0 and not result["outerBudgetExceeded"] and not result["interrupted"]
        assert re.search(r"^\s*188 passing", log, re.M) and not result["timeoutLines"]
        events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()]
        ready = [event for event in events if event["event"] == "worker-ready"]
        assert len(ready) == 2 and len({event["config"] for event in ready}) == 2
        starts = [event for event in events if event["event"] == "file-start"]
        assert len(starts) == 4 and len({event["file"] for event in starts}) == 4
        completed = [event for event in events if event["event"] == "file-complete"]
        assert len(completed) == 4 and all(event["fixtureExists"] for event in completed)
        assert any(sum(event["worker"] == worker["worker"] for event in starts) > 1 for worker in ready)
        assert all(not Path(event["config"]).exists() and not Path(event["config"]).parent.exists() for event in ready)
        write(directory / "verified.json", {"passing": 188, "workers": ready, "reuseAndCleanupVerified": True})
    finally:
        cleanup(temporary, directory)


def sample(number):
    assert 1 <= number <= len(ORDER)
    assert (ARTIFACTS / "probe/verified.json").exists()
    for previous in range(1, number):
        assert (ARTIFACTS / f"{previous:02d}-{ORDER[previous - 1]}/verified.json").exists()
    directory = ARTIFACTS / f"{number:02d}-{ORDER[number - 1]}"
    assert not directory.exists(), "No sample retries or overwrites"
    directory.mkdir()
    env, temporary = child_env(ORDER[number - 1], directory)
    manifest = json.loads((ARTIFACTS / "preflight.json").read_text())
    assert git("rev-parse", "HEAD") == manifest["commit"] and not git("status", "--porcelain")
    write(directory / "provenance.json", {"commit": manifest["commit"], "tree": manifest["tree"],
          "lockSha256": sha(ROOT / "package-lock.json"), "mochaOptions": env["MOCHA_OPTIONS"],
          "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    try:
        result, log = execute(directory, ["npm", "test"], env, 900)
        raw = ROOT / "coverage/tmp"
        if raw.exists():
            with tarfile.open(directory / "raw-v8.tar.gz", "w:gz") as archive:
                archive.add(raw, arcname="coverage/tmp")
            captured = subprocess.run(["node", str(TOOLS / "coverage.cjs"), "capture", str(directory / "maps")], cwd=ROOT)
        else:
            captured = None
        assert result["exitCode"] == 0 and not result["outerBudgetExceeded"] and not result["interrupted"]
        assert not result["timeoutLines"] and re.search(r"^\s*1694 passing", log, re.M)
        assert not re.search(r"^\s*\d+ (?:pending|failing)", log, re.M)
        assert captured and captured.returncode == 0
        if number > 1:
            baseline = ARTIFACTS / "01-serial/maps"
            compared = subprocess.run(["node", str(TOOLS / "coverage.cjs"), "compare", str(baseline),
                                       str(directory / "maps"), str(directory / "comparison.json")], cwd=ROOT)
            assert compared.returncode == 0, "Coverage outcomes changed; stop before later samples"
        assert sha(ROOT / "package-lock.json") == LOCK and not git("status", "--porcelain")
    finally:
        cleanup(temporary, directory)
    write(directory / "verified.json", {"passing": 1694, "mode": ORDER[number - 1], "coverageAndCleanupVerified": True})


def summary():
    results = []
    for number, mode in enumerate(ORDER, 1):
        directory = ARTIFACTS / f"{number:02d}-{mode}"
        assert (directory / "verified.json").exists(), "Six complete verified samples are required"
        result = json.loads((directory / "result.json").read_text())
        results.append({"number": number, "mode": mode, "elapsedSeconds": result["elapsedSeconds"]})
    pairs = []
    for index in range(0, 6, 2):
        serial = next(item["elapsedSeconds"] for item in results[index:index + 2] if item["mode"] == "serial")
        parallel = next(item["elapsedSeconds"] for item in results[index:index + 2] if item["mode"] == "parallel2")
        pairs.append({"pair": index // 2 + 1, "serialSeconds": serial, "parallelSeconds": parallel,
                      "savePercent": 100 * (serial - parallel) / serial})
    distributions = {}
    for mode in ["serial", "parallel2"]:
        values = [item["elapsedSeconds"] for item in results if item["mode"] == mode]
        distributions[mode] = {"values": values, "median": statistics.median(values), "min": min(values),
                               "max": max(values), "sampleStddev": statistics.stdev(values)}
    gains = [pair["savePercent"] for pair in pairs]
    write(ARTIFACTS / "summary.json", {"samples": results, "pairs": pairs, "distributions": distributions,
          "medianPairedSavePercent": statistics.median(gains),
          "worthFurtherAdoptionReview": min(gains) > 0 and statistics.median(gains) >= 10,
          "adoption": "No default behavior change; requires a separate reviewed implementation"})


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise InterruptedError("CI command interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    command = sys.argv[1]
    if command == "preflight":
        preflight()
    elif command == "probe":
        probe()
    elif command == "sample":
        sample(int(sys.argv[2]))
    elif command == "summary":
        summary()
    else:
        raise ValueError(command)
