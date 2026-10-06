"""One bounded #319 adaptive comparison; no retry or automatic adoption."""
import base64, hashlib, io, json, os, re, shutil, signal, statistics, subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

HEAD = "f6759244d12f3f6eac2141f4c8b6da90887acded"
TREE = "d825bcfa9a8963e5061c006fda447934287857f6"
LOCK = "3abd4922490a95cf538c52e16e16fccc739b9c277d4217e21d0064efe9acd797"
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
DRIVER = Path(__file__).resolve().parent
ARTIFACTS = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "319-adaptive-evidence"
BUDGET = 1200
ORDINARY_SETUP_MARGIN = 180
ORDER = ("affinity2-adaptive", "quota2-node2415-adaptive", "four-serial", "four-adaptive", "four-adaptive", "four-serial")
CONTAINER = None
CONTAINER_REMOVAL_ATTEMPTED = False
DEADLINE = None
RUNTIMES = {}

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


def bounded(directory, label, command, env=None, timeout=120):
    """Bound preparation, evidence capture and owned-container cleanup too."""
    started = time.monotonic()
    with (directory / (label + ".stdout")).open("w") as out, (directory / (label + ".stderr")).open("w") as err:
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=out, stderr=err, timeout=timeout)
        except subprocess.TimeoutExpired:
            write(directory / (label + ".json"), {"command": command, "exitCode": None,
                  "interruptedByOuterCap": True, "outerBudgetSeconds": timeout})
            raise
    write(directory / (label + ".json"), {"command": command, "exitCode": result.returncode,
          "elapsedSeconds": time.monotonic() - started, "outerBudgetSeconds": timeout})
    if result.returncode != 0:
        raise RuntimeError(label + " failed")
    return (directory / (label + ".stdout")).read_text()


def sha(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def source_unchanged():
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True, timeout=30).strip()
    return (git("rev-parse", "HEAD") == HEAD and git("rev-parse", "HEAD^{tree}") == TREE
            and not git("status", "--porcelain") and sha(ROOT / "package-lock.json") == LOCK)


def selected_files():
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT, timeout=30).decode().split("\0")
    test_files = sorted(name for name in tracked if re.fullmatch(r"test/[^/]+\.ts", name))
    production = sorted(name for name in tracked if name.endswith(".ts") and name.split("/")[0] in {"commands", "config", "analytics-worker"})
    return {"testFiles": [{"path": name, "sha256": sha(ROOT / name)} for name in test_files],
            "productionFiles": production, "productionHashes": {name: sha(ROOT / name) for name in production}}


def validate_resources(info, cpus, node, quota=False):
    assert info["node"] == node and info["platform"] == "linux" and info["arch"] == "x64"
    assert info["uid"] == os.getuid() != 0 and info["gid"] == os.getgid()
    assert info["mocha"] == "11.7.6" and info["c8"] == "12.0.0"
    if node in RUNTIMES:
        assert all(info[key] == RUNTIMES[node][key] for key in ["v8", "executable", "mocha", "c8"])
    assert info["affinity"] == sorted(cpus)
    assert info["availableParallelism"] == (2 if quota else len(cpus))
    visible = info["cgroup"]["effectiveVisibleQuota"]
    if quota:
        assert len(cpus) == 4 and visible == 2
        assert any(item.get("value") == "200000 100000" for item in info["cgroup"]["quotas"])
    else:
        assert info["cgroup"]["mountRoot"] == "/", "Four-CPU capacity requires visible host ancestors"
        assert visible is None or visible >= len(cpus)


def validate_events(directory, mode, cpus, contract):
    rows = []
    for filename in sorted((directory / "events").glob("*.jsonl")):
        rows.extend(json.loads(line) for line in filename.read_text().splitlines())
    assert rows, "No actual Mocha runner evidence"
    main = [row for row in rows if not row["isWorker"]]
    workers = [row for row in rows if row["isWorker"]]
    assert len(main) == 1 and main[0]["workerId"] is None
    assert main[0]["files"] == contract["testFiles"], "Different full test selection"
    parallel = mode == "four-adaptive"
    assert main[0]["runnerClass"] == ("ParallelBufferedRunner" if parallel else "Runner")
    if parallel:
        assert main[0]["jobs"] == 2
        assert len({row["pid"] for row in workers}) == 2
        assert len({row["workerId"] for row in workers}) == 2
        assert all(row["runnerClass"] == "Runner" and row["workerId"] is not None for row in workers)
        assert sorted({item["path"] for row in workers for item in row["files"]}) == [item["path"] for item in contract["testFiles"]]
        assert all(item in contract["testFiles"] for row in workers for item in row["files"])
    else:
        assert not workers, "Serial main must create no Mocha workers"
        if mode != "four-serial":
            assert main[0]["jobs"] == 1
    for row in rows:
        validate_resources(row["resources"], cpus, "v24.15.0" if "node2415" in mode else "v24.21.0", "quota2" in mode)
    write(directory / "observed-mode.json", {"main": main, "workerPids": sorted({row["pid"] for row in workers}),
          "workerRuns": len(workers), "actualMode": "parallel" if parallel else "serial"})


def docker_command(command, env):
    assert CONTAINER is not None
    arguments = ["docker", "exec", "--workdir", str(ROOT)]
    for key, value in sorted(env.items()):
        arguments.extend(["--env", key + "=" + value])
    return [*arguments, CONTAINER, *command]


def remove_container(directory):
    global CONTAINER, CONTAINER_REMOVAL_ATTEMPTED
    if CONTAINER is None or CONTAINER_REMOVAL_ATTEMPTED:
        return
    CONTAINER_REMOVAL_ATTEMPTED = True
    owned = CONTAINER
    try:
        bounded(directory, "container-remove", ["docker", "rm", "--force", owned], timeout=60)
        CONTAINER = None
    finally:
        write(directory / "container-cleanup.json", {"ownedContainer": owned,
              "removedExitConfirmed": CONTAINER is None, "hostedVmTeardownObserved": False})


def abort_collection(directory, result, reason):
    result.update({"completedGate": False, "collectionAborted": True, "abortReason": reason,
                   "runnerTeardownRequired": True, "runnerTeardownObserved": False})
    write(directory / "result.json", result)
    write(ARTIFACTS / "summary.json", {"collectionComplete": False, "allGatesPassed": False,
          "stoppedAfterSample": directory.name, "pairs": [], "qualified": False, "abortReason": reason,
          "isolationBoundary": "dedicated GitHub-hosted job VM; owned quota container",
          "detachedDescendantsVerified": False, "runnerTeardownObserved": False})
    # Preserve files/logs and clean the specifically owned container. No further
    # tests, runtime probes or coverage diagnostics follow a failed gate.
    print(json.dumps(result), flush=True)
    raise SystemExit(1)


def bundle():
    memory = io.BytesIO()
    with tarfile.open(fileobj=memory, mode="w:gz") as archive:
        archive.add(ARTIFACTS, arcname="319-adaptive-evidence")
    data = memory.getvalue()
    if len(data) > 20 * 1024 * 1024:
        raise RuntimeError("Log evidence exceeds the fixed 20MiB cap")
    print("BEGIN_319_ADAPTIVE_EVIDENCE_TGZ " + hashlib.sha256(data).hexdigest(), flush=True)
    encoded = base64.b64encode(data).decode("ascii")
    for offset in range(0, len(encoded), 1024):
        print(encoded[offset:offset+1024], flush=True)
    print("END_319_ADAPTIVE_EVIDENCE_TGZ", flush=True)


def main():
    global CONTAINER, DEADLINE
    assert sys.platform == "linux" and os.getuid() != 0
    assert os.environ["GITHUB_ACTIONS"] == "true" and os.environ["RUNNER_ENVIRONMENT"] == "github-hosted"
    assert os.environ["GITHUB_REPOSITORY"] == "JBallin/ballin-scripts"
    assert os.environ["GITHUB_REF"] == "refs/heads/experiment/319-adaptive-evidence"
    assert os.environ["GITHUB_ACTOR"] == "JBallin" and os.environ["GITHUB_RUN_ATTEMPT"] == "1"
    assert source_unchanged()
    package = json.loads((ROOT / "package.json").read_text())
    assert package["scripts"]["test:unit"] == "mocha --parallel"
    assert package["c8"]["statements"] == package["c8"]["lines"] == 99.2
    assert package["c8"]["branches"] == 96.7 and package["c8"]["functions"] == 100
    permitted = sorted(os.sched_getaffinity(0))
    assert len(permitted) >= 4
    four = set(permitted[:4])
    ARTIFACTS.mkdir()
    driver_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=DRIVER.parents[2], text=True, timeout=30).strip()
    assert driver_head == os.environ["GITHUB_SHA"], "Driver checkout must match this dispatch"
    request = urllib.request.Request("https://api.github.com/repos/JBallin/ballin-scripts/actions/workflows/299906219/runs?branch=experiment%2F319-adaptive-evidence&event=workflow_dispatch&per_page=100",
                                    headers={"Accept": "application/vnd.github+json", "User-Agent": "ballin-319-bounded-comparison"})
    with urllib.request.urlopen(request, timeout=30) as response:
        history = json.loads(response.read(2 * 1024 * 1024))
    write(ARTIFACTS / "dispatch-history.json", history)
    assert history["total_count"] == 1 and len(history["workflow_runs"]) == 1, "Exactly one dispatch is approved"
    run = history["workflow_runs"][0]
    assert str(run["id"]) == os.environ["GITHUB_RUN_ID"] and run["head_sha"] == driver_head and run["run_attempt"] == 1
    started = int(os.environ["BENCH_319_JOB_STARTED_EPOCH"])
    DEADLINE = started + 138 * 60  # Reserve two minutes within the 140-minute job for cleanup/log retention.
    contract = selected_files()
    write(ARTIFACTS / "contract.json", {"commit": HEAD, "tree": TREE, "lockSha256": LOCK, **contract})
    os.sched_setaffinity(0, four)
    host_node = Path(os.environ["BENCH_319_NODE24_ROOT"]).resolve()
    older_node = Path(os.environ["BENCH_319_NODE2415_ROOT"]).resolve()
    base_env = {"PATH": str(host_node / "bin") + ":/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
                "LANG": "C.UTF-8", "TZ": "UTC", "CI": "true", "NODE_DISABLE_COMPILE_CACHE": "1",
                "BENCH_319_SOURCE": str(ROOT), "BENCH_319_CONTRACT": str(ARTIFACTS / "contract.json")}
    preflight = json.loads(bounded(ARTIFACTS, "host-capacity", ["node", str(DRIVER / "observe.cjs"), "--resources"], base_env))
    validate_resources(preflight, four, "v24.21.0")
    RUNTIMES["v24.21.0"] = preflight
    write(ARTIFACTS / "preflight.json", {"runtime": preflight, "order": ORDER, "sampleBudgetSeconds": BUDGET,
          "gateCountCap": 6, "jobBudgetMinutes": 140, "retries": 0,
          "constrainedInterpretation": "Two single smoke checks, not repeatability or the original full environment reproduction",
          "comparison": "Four-CPU Node24.21 ABBA only; identical preload/source/dependencies/selection; fresh fixtures and coverage"})
    name = "ballin-319-" + os.environ["GITHUB_RUN_ID"]
    create = ["docker", "create", "--name", name, "--label", "ballin319.run=" + os.environ["GITHUB_RUN_ID"],
              "--cpus=2", "--cpuset-cpus", ",".join(map(str, sorted(four))), "--user", str(os.getuid()) + ":" + str(os.getgid()),
              "--mount", f"type=bind,src={ROOT},dst={ROOT}",
              "--mount", f"type=bind,src={os.environ['RUNNER_TEMP']},dst={os.environ['RUNNER_TEMP']}",
              "--mount", f"type=bind,src={DRIVER},dst={DRIVER},readonly",
              "--mount", f"type=bind,src={older_node},dst=/opt/node,readonly", "ballin-319-quota:reviewed"]
    CONTAINER = bounded(ARTIFACTS, "container-create", create).strip()
    assert re.fullmatch(r"[0-9a-f]{64}", CONTAINER)
    bounded(ARTIFACTS, "container-start", ["docker", "start", CONTAINER])
    older_env = {**base_env, "PATH": "/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    quota_info = json.loads(bounded(ARTIFACTS, "quota-capacity", docker_command(["node", str(DRIVER / "observe.cjs"), "--resources"], older_env)))
    validate_resources(quota_info, four, "v24.15.0", True)
    RUNTIMES["v24.15.0"] = quota_info
    assert time.time() - started <= 600, "Preparation exhausted its ten-minute allocation; no gates started"
    rows = []
    pairs = []
    expected_count = None
    for index, mode in enumerate(ORDER, 1):
        assert DEADLINE - time.time() >= BUDGET + 120, "Insufficient remaining budget; do not start another gate"
        assert source_unchanged()
        cpus = set(permitted[:2]) if index == 1 else four
        os.sched_setaffinity(0, cpus)
        directory = ARTIFACTS / f"{index:02d}-{mode}"
        directory.mkdir()
        scratch = Path(os.environ["RUNNER_TEMP"]) / f"319-adaptive-scratch-{index}"
        scratch.mkdir()
        for child in ["fixtures", "home", "npm-cache"]:
            (scratch / child).mkdir()
        events = directory / "events"
        events.mkdir()
        sample_env = {**(older_env if index == 2 else base_env), "HOME": str(scratch / "home"),
                      "TMPDIR": str(scratch / "fixtures"), "NPM_CONFIG_CACHE": str(scratch / "npm-cache"),
                      "BENCH_319_EVENT_DIR": str(events), "NODE_OPTIONS": "--require " + str(DRIVER / "observe.cjs")}
        coverage = ROOT / "coverage"
        assert not coverage.is_symlink()
        if coverage.exists():
            shutil.rmtree(coverage)
        # Adaptive samples use the actual default; only serial controls add a boolean flag.
        gate = ["npm", "test"] + (["--", "--", "--", "--no-parallel"] if mode == "four-serial" else [])
        command = docker_command(["/usr/bin/time", "-v", *gate], sample_env) if index == 2 else gate
        assert DEADLINE - time.time() >= BUDGET + 120, "Preparation left insufficient budget for another gate"
        write(directory / "provenance.json", {"commit": HEAD, "tree": TREE, "lockSha256": LOCK,
              "mode": mode, "command": gate, "environment": sample_env, "affinity": sorted(cpus),
              "comparisonEligible": index >= 3})
        result, log = execute(directory, command, sample_env, BUDGET)
        result["mode"] = mode
        result["completedStages"] = re.findall(r"^> ballin-scripts@\S+ (\S+)\s*$", log, re.M)
        result["passingCounts"] = [int(value) for value in re.findall(r"^\s*(\d+) passing", log, re.M)]
        completed = (result["exitCode"] == 0 and result["ownedGroupCleanup"] is None
                     and not result["outerBudgetExceeded"] and not result["interrupted"]
                     and len(result["passingCounts"]) == 1 and result["passingCounts"][0] > 0
                     and not result["timeoutLines"] and not re.search(r"^\s*[1-9]\d* (pending|failing)", log, re.M)
                     and result["completedStages"] == ["test", "lint", "typecheck", "typecheck:analytics-worker", "test:coverage", "test:unit"]
                     and "mocha --parallel" + (" --no-parallel" if mode == "four-serial" else "\n") in log)
        if not completed:
            abort_collection(directory, result, "Failed or incomplete gate; stop samples and dispose of the owned environment")
        try:
            validate_events(directory, mode, cpus, contract)
            if expected_count is None:
                expected_count = result["passingCounts"][0]
            assert result["passingCounts"] == [expected_count]
            assert source_unchanged()
            leftovers = sorted(item.name for item in (scratch / "fixtures").iterdir())
            assert all(item == "node-compile-cache" for item in leftovers), "Fixture leak"
            result["fixtureEntries"] = leftovers
        except Exception as error:
            abort_collection(directory, result, "Post-gate verification failed: " + str(error))
        if index == 2:
            remove_container(directory)
        if index >= 3:
            diagnostic_env = {key: value for key, value in sample_env.items() if key != "NODE_OPTIONS"}
            bounded(directory, "coverage-capture", ["node", str(DRIVER / "coverage.cjs"), "capture", str(directory)], diagnostic_env, timeout=60)
        result["completedGate"] = True
        write(directory / "result.json", result)
        print(json.dumps(result), flush=True)
        rows.append(result)
        shutil.rmtree(scratch)
        if index in {4, 6}:
            first, last = (2, 3) if index == 4 else (5, 4)
            serial, adaptive = rows[first], rows[last]
            output = ARTIFACTS / f"pair-{len(pairs)+1}-coverage.json"
            bounded(ARTIFACTS, f"pair-{len(pairs)+1}-compare", ["node", str(DRIVER / "coverage.cjs"), "compare",
                    str(ARTIFACTS / f"{first+1:02d}-{ORDER[first]}"), str(ARTIFACTS / f"{last+1:02d}-{ORDER[last]}"), str(output)], base_env, timeout=60)
            gain = 100 * (serial["elapsedSeconds"] - adaptive["elapsedSeconds"]) / serial["elapsedSeconds"]
            pairs.append({"serialSeconds": serial["elapsedSeconds"], "adaptiveSeconds": adaptive["elapsedSeconds"], "reductionPercent": gain})
    median = statistics.median(pair["reductionPercent"] for pair in pairs)
    ordinary_margin = 1200 - max(row["elapsedSeconds"] for row in rows if row["mode"] == "four-adaptive")
    qualified = all(pair["reductionPercent"] > 0 for pair in pairs) and median >= 10 and ordinary_margin >= ORDINARY_SETUP_MARGIN
    summary = {"collectionComplete": True, "allGatesPassed": True, "pairs": pairs, "medianReductionPercent": median,
               "qualified": qualified, "coverageEquivalent": True, "passingTests": expected_count,
               "constrainedInterpretation": "Each constrained case is one successful smoke check; no repeatability claim",
               "ordinaryCi": "Still requires the actual 20-minute CI job, including setup and evidence margin",
               "ordinaryCiRemainingSeconds": ordinary_margin, "ordinaryCiReservedSetupSeconds": ORDINARY_SETUP_MARGIN,
               "detachedDescendantsVerified": False, "runnerTeardownObserved": False}
    write(ARTIFACTS / "summary.json", summary)
    print("ADAPTIVE_COMPARISON_SUMMARY " + json.dumps(summary), flush=True)
    if not qualified:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if ARTIFACTS.exists() and not (ARTIFACTS / "summary.json").exists():
            write(ARTIFACTS / "summary.json", {"collectionComplete": False, "qualified": False,
                  "error": str(error), "runnerTeardownRequired": True, "runnerTeardownObserved": False})
        raise
    finally:
        if ARTIFACTS.exists():
            try:
                remove_container(ARTIFACTS)
            finally:
                bundle()
