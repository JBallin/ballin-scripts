const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
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
  const raw = path.join(root, 'coverage/tmp');
  const wrapper = path.join(root, 'test/coverage.ts');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  fs.mkdirSync(directory, { recursive: true });
  const command = [wrapper, 'report', '--temp-directory', raw,
    '--reports-dir', directory, '--reporter=json', '--reporter=json-summary'];
  const started = performance.now();
  const result = spawnSync(process.execPath, command, {
    cwd: root, env, encoding: 'utf8', timeout: 60000,
  });
  fs.writeFileSync(path.join(directory, 'corrected-report.stdout'), result.stdout || '');
  fs.writeFileSync(path.join(directory, 'corrected-report.stderr'), result.stderr || '');
  fs.writeFileSync(path.join(directory, 'corrected-report-terminal.json'), JSON.stringify({
    executable: process.execPath, command, exitCode: result.status, signal: result.signal,
    error: result.error ? String(result.error) : null, elapsedSeconds: (performance.now() - started) / 1000,
    exitConfirmed: result.status !== null, strictChecksEnabled: true,
    wrapperSha256: crypto.createHash('sha256').update(fs.readFileSync(wrapper)).digest('hex'),
  }, null, 2) + '\n');
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const map = read(path.join(directory, 'coverage-final.json'));

  // Merge genuine raw records only. Unobserved files stay explicit and their
  // uncovered maps come from the corrected c8 CLI; no synthetic V8 counts.
  const { mergeProcessCovs } = require(path.join(root, 'node_modules/@bcoe/v8-coverage'));
  const selected = new Set(Object.keys(map));
  let merged = { result: [] };
  for (const filename of fs.readdirSync(raw).sort()) {
    const data = read(path.join(raw, filename));
    assert(Array.isArray(data.result));
    const scripts = [];
    for (const script of data.result) {
      let filename = script.url;
      if (filename.startsWith('file://')) filename = fileURLToPath(filename);
      if (!path.isAbsolute(filename) || !selected.has(filename)) continue;
      const maps = data['source-map-cache'] || {};
      assert(!maps[pathToFileURL(filename).href]?.data, 'Source-map coverage requires separate analysis');
      scripts.push({ ...script, url: filename });
    }
    merged = mergeProcessCovs([merged, { result: scripts }]);
  }
  const profiles = Object.fromEntries([...selected].map(filename => [path.relative(root, filename), {
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    rawObserved: false, functions: [],
  }]));
  for (const script of merged.result) {
    const relative = path.relative(root, script.url);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    profiles[relative] = {
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(script.url)).digest('hex'),
      rawObserved: true,
      functions: script.functions.map(fn => {
        const first = fn.ranges[0];
        return [fn.functionName, first.startOffset, first.endOffset, effectiveRegions(fn.ranges)];
      }).map(canonical).sort(),
    };
  }
  fs.writeFileSync(path.join(directory, 'effective-v8.json'), JSON.stringify(
    Object.fromEntries(Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b)))));
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
