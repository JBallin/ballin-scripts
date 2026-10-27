import collections, json, os, pathlib

base = pathlib.Path(os.environ['PERF_EVIDENCE']).resolve()
manifest = json.loads((base / 'manifest.json').read_text())
root = pathlib.Path(manifest['source']).resolve()
def read(p): return json.loads(p.read_text())
def rel(p):
    try: return str(pathlib.Path(p).resolve().relative_to(root))
    except ValueError: return p
def identity(test): return (rel(test.get('file', '')), test['fullTitle'])
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'))
def normalize_coverage(data):
    result = {}
    for file, cov in data.items():
        entries = []
        for kind, maps, counts in [('statement', 'statementMap', 's'), ('function', 'fnMap', 'f'), ('branch', 'branchMap', 'b')]:
            for key, location in cov[maps].items():
                count = cov[counts][key]
                outcome = [v > 0 for v in count] if isinstance(count, list) else count > 0
                entries.append(canonical([kind, location, outcome]))
        result[rel(file)] = collections.Counter(entries)
    return result
def arm(jobs):
    p = base / f'workers-{jobs}'
    receipt, mocha = read(p/'receipt.json'), read(p/'mocha.json')
    trace = [json.loads(line) for line in (p/'trace.jsonl').read_text().splitlines()]
    starts = [r for r in trace if r['kind']=='file-start' and 'worker' in r]
    ends = [r for r in trace if r['kind']=='file-end' and 'worker' in r]
    enqueue = [rel(r['file']) for r in trace if r['kind']=='enqueue']
    by_worker = collections.defaultdict(list)
    for r in starts: by_worker[r['worker']].append(r)
    configs = {r['config'] for r in starts}
    resources = [json.loads(line) for line in (p/'resources.jsonl').read_text().splitlines()]
    file_times = []
    for r in starts:
        end = next((e for e in ends if e['pid']==r['pid'] and e['files']==r['files']), None)
        file_times.append(dict(file=rel(r['files'][0]), worker=r['worker'], elapsedSeconds=(end['time']-r['time'])/1000 if end else None))
    summary = dict(jobs=jobs, receipt=receipt, stats=mocha['stats'],
        enqueueMatchesManifest=enqueue==manifest['files'],
        workerFileMembershipMatches=collections.Counter(rel(r['files'][0]) for r in starts)==collections.Counter(manifest['files']),
        allFileEndsPresent=len(starts)==len(ends)==len(manifest['files']),
        distinctWorkers=len(by_worker), configCount=len(configs),
        configUniqueAcrossWorkers=len(configs)==len(by_worker),
        configStableAcrossReuse=all(r['stableConfig'] and r['configExists'] for r in starts),
        configLifetimeStablePerWorker=all(len({r['config'] for r in records})==1 for records in by_worker.values()),
        configsRemovedAfterExit=all(not os.path.exists(c) for c in configs),
        filesPerWorker={k:len(v) for k,v in by_worker.items()},
        workerProfilePaths=sorted({r.get('coverage','') for r in starts}),
        peakSampledDescendantRssMiB=max(sum(r['rssKiB'] for r in s['processes'])/1024 for s in resources),
        peakSampledDescendantCount=max(len(s['processes']) for s in resources),
        loadRange=[min(s['load'][0] for s in resources),max(s['load'][0] for s in resources)],
        fileTimings=file_times,
        rawUniquePids=len({f.name.split('-')[1] for f in (p/'raw').glob('coverage-*.json')}))
    return summary, mocha, normalize_coverage(read(p/'report/coverage-final.json'))

a, am, ac = arm(2)
b, bm, bc = arm(4)
diff = []
for file in sorted(set(ac)|set(bc)):
    old, new = ac.get(file, collections.Counter()), bc.get(file, collections.Counter())
    if old != new:
        diff.append(dict(file=file, onlyTwo=list((old-new).elements()), onlyFour=list((new-old).elements())))
outcomes = {k:collections.Counter(identity(t) for t in am[k])==collections.Counter(identity(t) for t in bm[k]) for k in ['tests','passes','pending','failures']}
comparison = dict(two=a, four=b, testOutcomeParity=outcomes, coverageFileCount=[len(ac),len(bc)],
    coverageExactLocationOutcomeParity=not diff, coverageDifferences=diff,
    wallReductionSeconds=a['receipt']['wallSeconds']-b['receipt']['wallSeconds'],
    wallReductionPercent=(1-b['receipt']['wallSeconds']/a['receipt']['wallSeconds'])*100)
duration_maps = []
for report in [am,bm]:
    grouped = collections.defaultdict(list)
    for test in report['passes']: grouped[identity(test)].append(test.get('duration',0))
    duration_maps.append(grouped)
regressions = []
ratios = []
for key, values in duration_maps[0].items():
    others = duration_maps[1].get(key,[])
    if len(values)==len(others)==1 and values[0]>=100:
        before,after = values[0],others[0]
        ratios.append(after/before)
        if after-before>=100:
            regressions.append(dict(file=key[0],test=key[1],twoMs=before,fourMs=after,increaseMs=after-before,ratio=after/before))
comparison['individualTestRegressions'] = sorted(regressions,key=lambda r:r['increaseMs'],reverse=True)
import statistics
comparison['medianTestRatioForBaselineAtLeast100ms'] = statistics.median(ratios) if ratios else None
comparison['ratioCaseCount'] = len(ratios)
(base/'comparison.json').write_text(json.dumps(comparison,indent=2))
print(json.dumps({k:v for k,v in comparison.items() if k not in ['two','four','coverageDifferences']},indent=2))
if not all(outcomes.values()):
    raise SystemExit('Test identity/outcome mismatch between worker counts')
