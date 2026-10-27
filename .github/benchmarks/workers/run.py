import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, time

harness = pathlib.Path(__file__).resolve().parent
base = pathlib.Path(os.environ['PERF_EVIDENCE']).resolve()
source = pathlib.Path(os.environ['PERF_SOURCE']).resolve()
manifest = json.loads((base / 'manifest.json').read_text())
jobs = int(sys.argv[1])
assert jobs in (2, 4)
arm = base / f'workers-{jobs}'
arm.mkdir(exist_ok=False)
runtime = base / f'runtime-{jobs}'
runtime.mkdir(exist_ok=False)
for name in ('home', 'tmp'):
    (runtime / name).mkdir()
(arm / 'report').mkdir()
for item in manifest['sourceInventory']:
    assert hashlib.sha256((source / item['file']).read_bytes()).hexdigest() == item['sha256'], item['file']
env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL', 'SHELL')}
env.update(HOME=str(runtime / 'home'), TMPDIR=str(runtime / 'tmp'), CI='true', PERF_SOURCE=str(source), PERF_MANIFEST=str(base/'manifest.json'), PERF_TRACE=str(arm / 'trace.jsonl'))
command = [manifest['execPath'], '--max-old-space-size=6144', 'test/coverage.ts',
    '--temp-directory=' + str(arm / 'raw'), '--reports-dir=' + str(arm / 'report'),
    '--reporter=text', '--reporter=html', '--reporter=json', '--reporter=json-summary',
    manifest['execPath'], 'node_modules/mocha/bin/mocha.js', '--parallel', '--jobs', str(jobs),
    '--reporter', 'json', '--reporter-option', 'output=' + str(arm / 'mocha.json'),
    '--require', str(harness / 'probe.js'), *manifest['files']]
receipt = dict(command=command, cwd=str(source), env=env, boundSeconds=1500,
    startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), jobs=jobs)
(arm / 'command.json').write_text(json.dumps(receipt, indent=2))
start = time.monotonic()
with (arm / 'stdout.log').open('w') as out, (arm / 'stderr.log').open('w') as err, (arm / 'resources.jsonl').open('w') as resources:
    child = subprocess.Popen(command, cwd=source, env=env, stdout=out, stderr=err, start_new_session=True)
    receipt['pid'] = child.pid
    (arm / 'active.json').write_text(json.dumps(receipt, indent=2))
    timed_out = False
    while child.poll() is None:
        ps = subprocess.run(['ps', '-axo', 'pid=,ppid=,%cpu=,rss=,comm='], capture_output=True, text=True)
        rows = []
        for line in ps.stdout.splitlines():
            fields = line.split(None, 4)
            if len(fields) == 5:
                rows.append(dict(pid=int(fields[0]), ppid=int(fields[1]), cpu=float(fields[2]), rssKiB=int(fields[3]), executable=fields[4]))
        owned = {child.pid}
        for _ in rows:
            added = {row['pid'] for row in rows if row['ppid'] in owned} - owned
            if not added: break
            owned.update(added)
        resources.write(json.dumps(dict(elapsed=time.monotonic()-start, load=os.getloadavg(), processes=[r for r in rows if r['pid'] in owned]))+'\n')
        resources.flush()
        if int(time.monotonic()-start) % 60 < 15:
            trace = arm/'trace.jsonl'
            rows = []
            for line in trace.read_text().splitlines() if trace.exists() else []:
                try: rows.append(json.loads(line))
                except json.JSONDecodeError: pass  # A concurrent append can leave a partial last line.
            completed = sum(r['kind']=='file-end' and 'worker' in r for r in rows)
            print(json.dumps(dict(jobs=jobs, elapsedSeconds=round(time.monotonic()-start), completedFiles=completed, pid=child.pid)), flush=True)
        try:
            child.wait(timeout=min(15, max(0.1, 1500-(time.monotonic()-start))))
        except subprocess.TimeoutExpired:
            if time.monotonic()-start >= 1500:
                timed_out = True
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                break
receipt.update(endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), wallSeconds=time.monotonic()-start,
    returncode=child.returncode, timedOut=timed_out)
receipt['sourceUnchanged'] = all(hashlib.sha256((source / r['file']).read_bytes()).hexdigest()==r['sha256'] for r in manifest['sourceInventory'])
raw = list((arm / 'raw').glob('coverage-*.json'))
receipt.update(rawProfiles=len(raw), rawBytes=sum(p.stat().st_size for p in raw))
for name in ('mocha.json', 'report/coverage-summary.json'):
    p = arm / name
    if p.exists():
        d = json.loads(p.read_text())
        receipt[name] = d.get('stats', d.get('total'))
(arm / 'receipt.json').write_text(json.dumps(receipt, indent=2))
rows = [json.loads(line) for line in (arm/'trace.jsonl').read_text().splitlines()] if (arm/'trace.jsonl').exists() else []
starts = [r for r in rows if r['kind']=='file-start' and 'worker' in r]
ends = [r for r in rows if r['kind']=='file-end' and 'worker' in r]
relative = lambda f: str(pathlib.Path(f).resolve().relative_to(source))
configs = {r['config'] for r in starts}
receipt['isolationChecks'] = dict(order=[relative(r['file']) for r in rows if r['kind']=='enqueue']==manifest['files'], membership=sorted(relative(r['files'][0]) for r in starts)==sorted(manifest['files']), completions=len(starts)==len(ends)==len(manifest['files']), workers=len({r['worker'] for r in starts})==jobs, configs=len(configs)==jobs, stable=all(r['stableConfig'] and r['configExists'] for r in starts), cleanup=all(not os.path.exists(c) for c in configs))
(arm/'receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt, indent=2), flush=True)
sys.exit(0 if child.returncode == 0 and not timed_out and receipt['sourceUnchanged'] and all(receipt['isolationChecks'].values()) else 1)
