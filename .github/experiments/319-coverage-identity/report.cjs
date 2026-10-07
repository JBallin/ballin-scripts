'use strict';
// Convert already-retained profiles; never execute a Ballin module or test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fileURLToPath} = require('node:url');
const source = '/source';
const cell = process.argv[2];
const subject = process.argv[3];
assert.ok(subject === 'backup_cache.ts' || subject === 'backup_cache.cjs');
assert.ok(/^\/evidence\/cells\/\d\d-v24(?:15|21)-(?:ts|cjs)$/.test(cell));
const fixture = path.join(cell, 'fixture');
assert.equal(process.cwd(), fixture);
const raw = path.join(cell, 'raw');
const directory = path.join(cell, 'report');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
fs.mkdirSync(directory);
const Report = require(path.join(source, 'node_modules/c8/lib/report.js'));
const {checkCoverages} = require(path.join(source, 'node_modules/c8/lib/commands/check-coverage.js'));
const versions = Object.fromEntries(['c8', 'v8-to-istanbul', '@bcoe/v8-coverage'].map(name => [name,
  JSON.parse(fs.readFileSync(path.join(source, 'node_modules', name, 'package.json'))).version]));
assert.deepEqual(versions, {c8: '12.0.0', 'v8-to-istanbul': '9.3.0', '@bcoe/v8-coverage': '1.0.2'});
const thresholds = {statements: 99.2, lines: 99.2, branches: 96.7, functions: 100};
const subjectPath = path.join(fixture, subject);
const bytes = fs.readFileSync(subjectPath);
const sourceMetadata = {path: subjectPath, sha256: sha(bytes), bytes: bytes.length,
  utf16Length: bytes.toString('utf8').length};
const options = {all: true, extension: ['.ts', '.cjs'], include: [subject], exclude: [],
  src: fixture, resolve: fixture, tempDirectory: raw, reportsDirectory: directory,
  reporter: ['text', 'json', 'json-summary'], excludeNodeModules: true};
const profiles = fs.readdirSync(raw).sort().filter(name => /^coverage-\d+-\d+-\d+\.json$/.test(name));
assert.ok(profiles.length > 0);
const normalizer = Report(options);
const fileIndex = new Set();
const selectedRecords = [];
for (const filename of profiles) {
  const data = fs.readFileSync(path.join(raw, filename));
  const profile = JSON.parse(data);
  const selected = profile.result.filter(script => {
    const resolved = script.url.startsWith('file://') ? fileURLToPath(script.url) : script.url;
    return resolved === subjectPath;
  });
  const maps = Object.entries(profile['source-map-cache'] || {}).filter(([url]) => {
    try {return fileURLToPath(url) === subjectPath;} catch {return url === subjectPath;}
  });
  selectedRecords.push({filename, sha256: sha(data), bytes: data.length,
    sourceMapCacheKeys: Object.keys(profile['source-map-cache'] || {}),
    subjectSourceMapCache: maps, scripts: selected});
  normalizer._normalizeProcessCov(structuredClone(profile), fileIndex);
}
assert.ok(selectedRecords.some(record => record.scripts.length > 0), 'No raw coverage for selected subject');
assert.equal(selectedRecords.flatMap(record => record.scripts).flatMap(script => script.functions)
  .filter(fn => fn.functionName === 'repositoryCacheDirectory')
  .reduce((sum, fn) => sum + fn.ranges[0].count, 0), 2, 'The real named function must have both asserted calls');
const indexedFiles = [...fileIndex];
const emptyReports = normalizer._includeUncoveredFiles(fileIndex);
write('raw-analysis.json', {source: sourceMetadata, profiles: selectedRecords, indexedFiles, emptyReports});

(async () => {
  const report = Report(options);
  const merged = report._getMergedProcessCov();
  assert.equal(merged.result.length, 1);
  assert.equal(merged.result[0].url, subjectPath);
  write('merged-v8.json', merged);
  await report.run();
  const map = await report.getCoverageMapFromAllCoverageFiles();
  assert.deepEqual(map.files(), [subjectPath]);
  const summary = map.getCoverageSummary().toJSON();
  await checkCoverages({...thresholds, perFile: false}, report);
  const exitCode = process.exitCode || 0;
  const expectedPass = Object.entries(thresholds).every(([metric, threshold]) => summary[metric].pct >= threshold);
  assert.equal(exitCode, expectedPass ? 0 : 1);
  write('result.json', {complete: true, versions, thresholds, reporterNode: process.version,
    reporterV8: process.versions.v8, reporterExecutable: process.execPath, source: sourceMetadata,
    summary, coverageCheckPassed: expectedPass, expectedExitCode: exitCode});
})().catch(error => {console.error(error.stack); process.exitCode = 2;});
