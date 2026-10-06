const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = fs.realpathSync(process.cwd());
const canonical = value => JSON.stringify(value);
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

function normalize(map) {
  return Object.fromEntries(Object.entries(map).map(([filename, data]) => {
    const relative = path.relative(root, filename);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    const statements = Object.entries(data.statementMap)
      .map(([id, location]) => canonical([location, data.s[id] > 0])).sort();
    const functions = Object.entries(data.fnMap)
      .map(([id, location]) => canonical([location, data.f[id] > 0])).sort();
    const branches = Object.entries(data.branchMap)
      .map(([id, location]) => canonical([location, data.b[id].map(count => count > 0)])).sort();
    return [relative, { statements, functions, branches }];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

function effectiveRegions(ranges) {
  const bounds = [...new Set(ranges.flatMap(range => [range.startOffset, range.endOffset]))].sort((a, b) => a - b);
  const regions = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const start = bounds[index];
    const end = bounds[index + 1];
    const deepest = ranges.filter(range => range.startOffset <= start && range.endOffset >= end).at(-1);
    assert(deepest);
    const covered = deepest.count > 0;
    const previous = regions.at(-1);
    if (previous && previous[1] === start && previous[2] === covered) previous[1] = end;
    else regions.push([start, end, covered]);
  }
  return regions;
}

async function capture(directory) {
  const pkg = read(path.join(root, 'package.json'));
  const Report = require(path.join(root, 'node_modules/c8/lib/report.js'));
  const report = Report({ ...pkg.c8, tempDirectory: path.join(root, 'coverage/tmp'), resolve: root, excludeNodeModules: true });
  const merged = report._getMergedProcessCov();
  const profiles = {};
  for (const script of merged.result) {
    assert(!report.sourceMapCache[pathToFileURL(script.url).href]?.data, 'Source-map coverage requires separate analysis');
    const relative = path.relative(root, script.url);
    profiles[relative] = {
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(script.url)).digest('hex'),
      functions: script.functions.map(fn => {
        const first = fn.ranges[0];
        return [fn.functionName, first.startOffset, first.endOffset, effectiveRegions(fn.ranges)];
      }).map(canonical).sort(),
    };
  }
  const map = await report.getCoverageMapFromAllCoverageFiles();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'coverage-final.json'), JSON.stringify(map.toJSON()));
  fs.writeFileSync(path.join(directory, 'coverage-summary.json'), JSON.stringify({ total: map.getCoverageSummary().toJSON() }));
  fs.writeFileSync(path.join(directory, 'effective-v8.json'), JSON.stringify(Object.fromEntries(Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b)))));
}

function compare(left, right, output) {
  const a = normalize(read(path.join(left, 'coverage-final.json')));
  const b = normalize(read(path.join(right, 'coverage-final.json')));
  const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const different = key => files.filter(file => canonical(a[file]?.[key]) !== canonical(b[file]?.[key]));
  const profilesA = read(path.join(left, 'effective-v8.json'));
  const profilesB = read(path.join(right, 'effective-v8.json'));
  const effectiveDifferences = files.filter(file => canonical(profilesA[file]) !== canonical(profilesB[file]));
  const result = {
    left, right, files: files.length,
    statementDifferences: different('statements'), functionDifferences: different('functions'),
    branchGeometryDifferences: different('branches'), effectiveV8Differences: effectiveDifferences,
    totals: [left, right].map(directory => read(path.join(directory, 'coverage-summary.json')).total),
  };
  const expected = read(process.env.BENCH_319_CONTRACT).productionFiles;
  result.expectedFiles = expected;
  result.fileSelectionMatches = canonical(Object.keys(a).sort()) === canonical(expected)
    && canonical(Object.keys(b).sort()) === canonical(expected);
  result.equivalent = result.fileSelectionMatches && result.statementDifferences.length === 0
    && result.functionDifferences.length === 0 && effectiveDifferences.length === 0;
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  if (!result.equivalent) process.exitCode = 1;
}

(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'capture') await capture(args[0]);
  else if (command === 'compare') compare(...args);
  else throw Error('Expected capture or compare');
})().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
