"""Unpublished #319 four-cell coverage-identity diagnostic; never a full gate."""
import base64, datetime, hashlib, importlib.util, io, json, os, re, shutil, signal, subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

HEAD = "f6759244d12f3f6eac2141f4c8b6da90887acded"
TREE = "d825bcfa9a8963e5061c006fda447934287857f6"
LOCK = "3abd4922490a95cf538c52e16e16fccc739b9c277d4217e21d0064efe9acd797"
SUBJECT_SHA = "68c8a46a2790b995c5c1a9ba510e1983714c56d93d27ca11cb2ac48278a0d4e5"
BRANCH = "experiment/319-coverage-identity"
WORKFLOW = "299906219"
HELPER_SHA = "981c3c54874437db3f328c36ff7363f55bb8eadddf11a4ac9265e465dd45f9c9"
DOCKERFILE_SHA = "edbde856e7c5a722a8f1e3bb7ee8193dbbc9906bfeb0f5131a1e28aac6117fc1"
ORDER = (("24.15.0", "ts"), ("24.15.0", "cjs"), ("24.21.0", "ts"), ("24.21.0", "cjs"))
DRIVER = Path(__file__).resolve().parent
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
ARTIFACTS = None
CONTAINER = None
CONTAINER_NAME = None
DEADLINE = None
CLEANUP_DEADLINE = None
CANCELLED = False
SHARED = None

def write(filename, value):
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_text(json.dumps(value, indent=2) + "\n")

def sha(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()

def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True, timeout=10).strip()

def validate_dispatch(env, history, driver_head):
    assert env["GITHUB_ACTIONS"] == "true" and env["RUNNER_ENVIRONMENT"] == "github-hosted"
    assert env["GITHUB_REPOSITORY"] == "JBallin/ballin-scripts"
    assert env["GITHUB_REF"] == "refs/heads/" + BRANCH
    assert env["GITHUB_ACTOR"] == "JBallin" and env["GITHUB_RUN_ATTEMPT"] == "1"
    assert re.fullmatch(r"[0-9a-f]{40}", driver_head)
    assert env["GITHUB_SHA"] == env["DIAGNOSTIC_319_REVIEWED_DRIVER_SHA"] == driver_head
    assert history["total_count"] == 1 and len(history["workflow_runs"]) == 1
    run = history["workflow_runs"][0]
    assert str(run["id"]) == env["GITHUB_RUN_ID"] and run["head_sha"] == driver_head
    assert run["run_attempt"] == 1 and run["event"] == "workflow_dispatch"
    assert run["workflow_id"] == int(WORKFLOW)
    assert run["head_branch"] == BRANCH and run["actor"]["login"] == "JBallin"

def source_unchanged():
    assert git(ROOT, "rev-parse", "HEAD") == HEAD and git(ROOT, "rev-parse", "HEAD^{tree}") == TREE
    assert not git(ROOT, "status", "--porcelain")
    assert sha(ROOT / "package-lock.json") == LOCK
    assert sha(ROOT / "commands/backup_cache.ts") == SUBJECT_SHA
    package = json.loads((ROOT / "package.json").read_text())
    assert package["c8"]["all"] is True
    assert {key: package["c8"][key] for key in ["statements", "lines", "branches", "functions"]} == {
        "statements": 99.2, "lines": 99.2, "branches": 96.7, "functions": 100}

def api(path):
    request = urllib.request.Request("https://api.github.com/repos/JBallin/ballin-scripts/" + path,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "ballin-319-identity-diagnostic"})
    with urllib.request.urlopen(request, timeout=15) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    assert len(data) <= 2 * 1024 * 1024
    return json.loads(data)

def run(directory, label, command, env, cap, deadline=None):
    assert not CANCELLED
    remaining = (DEADLINE if deadline is None else deadline) - time.time()
    assert remaining >= 1, "No time remains for another operation"
    result, output = SHARED.execute(directory / label, command, env, min(cap, remaining))
    assert not result["outerBudgetExceeded"] and not result["interrupted"] and result["ownedGroupCleanup"] is None, "Incomplete operation"
    assert result["exitCode"] is not None, "No confirmed terminal exit"
    return result, output

def required(directory, label, command, env, cap, deadline=None):
    result, output = run(directory, label, command, env, cap, deadline)
    assert result["exitCode"] == 0, label + " failed"
    return output

def container_command(command, env, cwd="/source"):
    assert CONTAINER is not None
    return ["docker", "exec", "--workdir", cwd, CONTAINER, "/usr/bin/env", "-i",
        *[key + "=" + value for key, value in sorted(env.items())], *command]

def retain_raw(cell):
    raw = cell / "raw"
    names = sorted(raw.glob("coverage-*.json"))
    assert names, "No raw profile to retain"
    assert sum(p.stat().st_size for p in names) <= 10 * 1024 * 1024
    manifest = [{"path": p.name, "bytes": p.stat().st_size, "sha256": sha(p)} for p in names]
    write(cell / "raw-manifest.json", manifest)
    return manifest

def cleanup():
    global CONTAINER
    if ARTIFACTS is None or CONTAINER_NAME is None:
        return
    record = {"ownedContainerName": CONTAINER_NAME, "ownedContainerId": CONTAINER,
        "removedExitConfirmed": False, "hostedVmTeardownObserved": False}
    try:
        timeout = max(1, min(20, CLEANUP_DEADLINE - time.time()))
        inspect = subprocess.run(["docker", "inspect", CONTAINER or CONTAINER_NAME],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, text=True)
        write(ARTIFACTS / "cleanup-inspect.json", {"exitCode": inspect.returncode, "stdout": inspect.stdout, "stderr": inspect.stderr})
        if inspect.returncode == 0:
            info = json.loads(inspect.stdout)
            assert len(info) == 1
            labels = info[0]["Config"]["Labels"]
            assert info[0]["Name"] == "/" + CONTAINER_NAME
            assert labels["ballin319.identity.run"] == os.environ["GITHUB_RUN_ID"]
            assert labels["ballin319.identity.driver"] == os.environ["GITHUB_SHA"]
            owned = info[0]["Id"]
            assert re.fullmatch(r"[0-9a-f]{64}", owned)
            assert CONTAINER is None or CONTAINER == owned
            record["ownedContainerId"] = owned
            remaining = CLEANUP_DEADLINE - time.time()
            assert remaining > 1
            result = subprocess.run(["docker", "rm", "--force", owned], stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=min(35, remaining), text=True)
            record.update({"command": ["docker", "rm", "--force", owned], "exitCode": result.returncode,
                "stdout": result.stdout, "stderr": result.stderr, "removedExitConfirmed": result.returncode == 0})
            if result.returncode == 0:
                CONTAINER = None
        else:
            record["absenceNotIndependentlyProven"] = True
    except Exception as error:
        record["error"] = repr(error)
    finally:
        write(ARTIFACTS / "container-cleanup.json", record)

def bundle():
    if ARTIFACTS is None:
        return
    files = sorted(p for p in ARTIFACTS.rglob("*") if p.is_file())
    write(ARTIFACTS / "manifest.json", [{"path": str(p.relative_to(ARTIFACTS)), "bytes": p.stat().st_size,
        "sha256": sha(p)} for p in files])
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        archive.add(ARTIFACTS, arcname="319-coverage-identity-evidence")
    data = stream.getvalue()
    assert len(data) <= 20 * 1024 * 1024
    print("BEGIN_319_COVERAGE_IDENTITY_TGZ " + hashlib.sha256(data).hexdigest(), flush=True)
    encoded = base64.b64encode(data).decode("ascii")
    for offset in range(0, len(encoded), 1024):
        print(encoded[offset:offset+1024], flush=True)
    print("END_319_COVERAGE_IDENTITY_TGZ", flush=True)

def main():
    global ARTIFACTS, CONTAINER, CONTAINER_NAME, DEADLINE, CLEANUP_DEADLINE, SHARED
    assert sys.platform == "linux" and os.getuid() == os.getgid() == 1001
    driver_root = DRIVER.parents[2]
    assert not git(driver_root, "status", "--porcelain")
    driver_head = git(driver_root, "rev-parse", "HEAD")
    # Reject an unauthorized platform/ref/actor before any setup or fixture operation.
    early = os.environ
    assert early["GITHUB_REPOSITORY"] == "JBallin/ballin-scripts"
    assert early["GITHUB_REF"] == "refs/heads/" + BRANCH and early["GITHUB_ACTOR"] == "JBallin"
    assert early["GITHUB_RUN_ATTEMPT"] == "1" and early["DIAGNOSTIC_319_REVIEWED_DRIVER_SHA"] == driver_head == early["GITHUB_SHA"]
    source_unchanged()
    assert sha(DRIVER.parent / "319-adaptive/measure.py") == HELPER_SHA
    assert sha(DRIVER.parent / "319-adaptive/Dockerfile") == DOCKERFILE_SHA
    history = api("actions/workflows/" + WORKFLOW + "/runs?branch=experiment%2F319-coverage-identity&event=workflow_dispatch&per_page=100")
    validate_dispatch(os.environ, history, driver_head)
    jobs = api("actions/runs/" + os.environ["GITHUB_RUN_ID"] + "/jobs?per_page=100")
    assert jobs["total_count"] == 1 and len(jobs["jobs"]) == 1
    assert jobs["jobs"][0]["name"] == "coverage-identity"
    started = datetime.datetime.fromisoformat(jobs["jobs"][0]["started_at"].replace("Z", "+00:00")).timestamp()
    assert started <= time.time() and time.time() - started < 300
    DEADLINE = started + 540
    CLEANUP_DEADLINE = started + 590
    setup_deadline = started + 300
    scratch = Path(os.environ["RUNNER_TEMP"]) / ("319-identity-scratch-" + os.environ["GITHUB_RUN_ID"])
    ARTIFACTS = Path(os.environ["RUNNER_TEMP"]) / "319-coverage-identity-evidence"
    scratch.mkdir()
    ARTIFACTS.mkdir()
    write(ARTIFACTS / "dispatch-history.json", history)
    write(ARTIFACTS / "job-clock.json", {"jobs": jobs, "startedEpoch": started, "setupDeadlineEpoch": setup_deadline,
        "operationDeadlineEpoch": DEADLINE, "cleanupDeadlineEpoch": CLEANUP_DEADLINE, "jobMinutes": 10, "dispatchCountCap": 1, "retries": 0})
    spec = importlib.util.spec_from_file_location("reviewed_adaptive_helpers", DRIVER.parent / "319-adaptive/measure.py")
    SHARED = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(SHARED)
    SHARED.ROOT = ROOT
    permitted = sorted(os.sched_getaffinity(0))
    assert len(permitted) >= 4
    cpus = permitted[:4]
    lock = json.loads((DRIVER / "runtime-lock.json").read_text())
    assert [row["version"] for row in lock] == ["24.15.0", "24.21.0"]
    roots = {}
    host_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(scratch / "home"),
        "TMPDIR": str(scratch / "tmp"), "LANG": "C.UTF-8", "CI": "true", "NODE_DISABLE_COMPILE_CACHE": "1",
        "NPM_CONFIG_CACHE": str(scratch / "npm-cache")}
    for name in ["home", "tmp", "npm-cache"]:
        (scratch / name).mkdir()
    for row in lock:
        assert row["url"] == "https://nodejs.org/dist/v" + row["version"] + "/" + row["filename"]
        remaining = setup_deadline - time.time()
        assert remaining > 1 and not CANCELLED
        destination = scratch / row["filename"]
        required(ARTIFACTS, "download-node-" + row["version"], ["curl", "--fail", "--silent", "--show-error", "--location",
            "--connect-timeout", "5", "--max-time", str(min(45, remaining)), "--max-filesize", str(64 * 1024 * 1024),
            "--output", str(destination), row["url"]], host_env, 45, setup_deadline)
        total = destination.stat().st_size
        assert total <= 64 * 1024 * 1024
        assert sha(destination) == row["sha256"]
        runtime = scratch / ("node" + row["version"])
        runtime.mkdir()
        required(ARTIFACTS, "extract-node-" + row["version"], ["tar", "-xf", str(destination), "--strip-components=1", "-C", str(runtime)], host_env, 30, setup_deadline)
        roots[row["version"]] = runtime
        write(ARTIFACTS / ("runtime-download-" + row["version"] + ".json"), {**row, "verified": True, "archiveBytes": total,
            "nodeBinarySha256": sha(runtime / "bin/node"), "npmVersion": json.loads((runtime / "lib/node_modules/npm/package.json").read_text())["version"]})
    dependency_env = {**host_env, "PATH": str(roots["24.21.0"] / "bin") + ":/usr/local/bin:/usr/bin:/bin"}
    required(ARTIFACTS, "locked-dependencies", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], dependency_env, 180, setup_deadline)
    source_unchanged()
    image = "ballin-319-identity:" + os.environ["GITHUB_RUN_ID"]
    required(ARTIFACTS, "image-build", ["docker", "build", "--platform", "linux/amd64", "--build-arg", "BENCH_UID=1001",
        "--build-arg", "BENCH_GID=1001", "--tag", image, str(DRIVER.parent / "319-adaptive")], host_env, 180, setup_deadline)
    CONTAINER_NAME = "ballin-319-identity-" + os.environ["GITHUB_RUN_ID"]
    create = ["docker", "create", "--init", "--name", CONTAINER_NAME, "--network=none", "--cpus=2", "--cpuset-cpus", ",".join(map(str, cpus)),
        "--user", "1001:1001", "--label", "ballin319.identity.run=" + os.environ["GITHUB_RUN_ID"],
        "--label", "ballin319.identity.driver=" + driver_head, "--mount", f"type=bind,src={ROOT},dst=/source,readonly",
        "--mount", f"type=bind,src={DRIVER},dst=/driver,readonly", "--mount", f"type=bind,src={ARTIFACTS},dst=/evidence"]
    for version, root in roots.items():
        create += ["--mount", f"type=bind,src={root},dst=/opt/node{version.replace('.', '')},readonly"]
    CONTAINER = required(ARTIFACTS, "container-create", [*create, image], host_env, 20, setup_deadline).strip()
    assert re.fullmatch(r"[0-9a-f]{64}", CONTAINER)
    write(ARTIFACTS / "owned-container.json", {"id": CONTAINER, "name": CONTAINER_NAME})
    required(ARTIFACTS, "container-start", ["docker", "start", CONTAINER], host_env, 20, setup_deadline)
    assert time.time() <= setup_deadline
    write(ARTIFACTS / "contract.json", {"sourceHead": HEAD, "sourceTree": TREE, "sourceLockSha256": LOCK,
        "subjectSha256": SUBJECT_SHA, "driverHead": driver_head, "driverTree": git(driver_root, "rev-parse", "HEAD^{tree}"),
        "runtimeLock": lock, "helperSha256": HELPER_SHA, "dockerfileSha256": DOCKERFILE_SHA,
        "cpus": cpus, "quota": "200000 100000", "order": ORDER, "probeCapSeconds": 20, "reportCapSeconds": 20,
        "thresholds": {"statements": 99.2, "lines": 99.2, "branches": 96.7, "functions": 100},
        "fullGateRun": False, "benchmarkRun": False, "retries": 0})
    cells = []
    for index, (version, extension) in enumerate(ORDER, 1):
        assert DEADLINE - time.time() >= 40
        cell = ARTIFACTS / "cells" / (f"{index:02d}-v{'2415' if version == '24.15.0' else '2421'}-{extension}")
        for name in ["fixture", "raw", "home", "tmp", "npm-cache"]:
            (cell / name).mkdir(parents=True)
        for filename in ["backup_cache.ts", "backup_cache.cjs", "package.json"]:
            shutil.copyfile(DRIVER / "fixture" / filename, cell / "fixture" / filename)
        assert sha(cell / "fixture/backup_cache.ts") == SUBJECT_SHA
        relative = str(cell.relative_to(ARTIFACTS))
        inside = "/evidence/" + relative
        environment = {"PATH": "/opt/node" + version.replace(".", "") + "/bin:/usr/bin:/bin", "HOME": inside + "/home",
            "TMPDIR": inside + "/tmp", "NPM_CONFIG_CACHE": inside + "/npm-cache", "LANG": "C.UTF-8", "CI": "true",
            "NODE_DISABLE_COMPILE_CACHE": "1", "NODE_V8_COVERAGE": inside + "/raw", "BENCH_319_EXPECTED_CPUS": json.dumps(cpus),
            "DIAGNOSTIC_319_EXPECTED_NODE": "v" + version}
        probe, output = run(cell, "probe", container_command(["node", "/driver/probe.cjs", "./backup_cache." + extension], environment, inside + "/fixture"), host_env, 20)
        manifest = retain_raw(cell)
        assert probe["exitCode"] == 0, "Probe assertion failed; no later runtime or reporter"
        observation = json.loads(output)
        assert observation["node"] == "v" + version
        assert observation["executable"] == "/opt/node" + version.replace(".", "") + "/bin/node"
        write(cell / "observed-probe.json", observation)
        report_env = {**environment, "PATH": "/opt/node24210/bin:/usr/bin:/bin"}
        report_env.pop("NODE_V8_COVERAGE")
        report, _ = run(cell, "coverage", container_command(["node", "/driver/report.cjs", inside, "backup_cache." + extension], report_env, inside + "/fixture"), host_env, 20)
        assert report["exitCode"] in [0, 1], "Reporter errored; no later cell"
        data = json.loads((cell / "report/result.json").read_text())
        assert data["complete"] and data["expectedExitCode"] == report["exitCode"]
        assert data["coverageCheckPassed"] == (report["exitCode"] == 0)
        assert manifest == retain_raw(cell), "Raw profiles changed during reporting"
        cells.append({"cell": relative, "probeExit": probe["exitCode"], "reportExit": report["exitCode"], "observation": observation, "coverage": data})
    assert len(cells) == 4
    assert all(row["observation"]["values"] == cells[0]["observation"]["values"] for row in cells)
    source_unchanged()
    write(ARTIFACTS / "summary.json", {"collectionComplete": True, "cells": cells,
        "diagnosticOnly": True, "fullQualification": False, "speedupClaim": False,
        "interpretation": "Inspect raw identities, real counts and empty-report injection; no automatic remediation or follow-up"})

if __name__ == "__main__":
    def cancelled(_signum, _frame):
        global CANCELLED
        CANCELLED = True
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    code = 0
    try:
        main()
    except BaseException as error:
        code = 1
        if ARTIFACTS is not None:
            write(ARTIFACTS / "summary.json", {"collectionComplete": False, "diagnosticOnly": True,
                "error": repr(error), "fullQualification": False, "speedupClaim": False})
        print(repr(error), file=sys.stderr, flush=True)
    finally:
        cleanup()
        if ARTIFACTS is not None:
            cleanup_result = json.loads((ARTIFACTS / "container-cleanup.json").read_text()) if (ARTIFACTS / "container-cleanup.json").exists() else {}
            if CONTAINER_NAME is not None and not cleanup_result.get("removedExitConfirmed"):
                code = 1
            try:
                bundle()
            except BaseException as error:
                print("Evidence preservation incomplete: " + repr(error), file=sys.stderr, flush=True)
                code = 1
    raise SystemExit(code)
