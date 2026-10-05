const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.realpathSync(process.cwd());
const log = process.env.PARALLEL_PROBE_LOG;
assert.ok(log, 'Set PARALLEL_PROBE_LOG to an isolated output file');
const worker = process.env.MOCHA_WORKER_ID;
let ownedConfig;
let lastFile;
function record(event, extra = {}) {
  fs.appendFileSync(log, JSON.stringify({event, worker, pid:process.pid, config:ownedConfig, ...extra}) + '\n');
}
function check() {
  if (ownedConfig === undefined) {
    ownedConfig = process.env.BALLIN_TEST_CONFIG_PATH;
    record('worker-ready');
  }
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CI, undefined);
  assert.equal(process.env.BALLIN_NO_ANALYTICS, '1');
  assert.equal(process.env.BALLIN_TEST_CONFIG_PATH, ownedConfig);
  assert.ok(path.basename(path.dirname(ownedConfig)).startsWith('ballin-config-'));
  assert.ok(fs.existsSync(ownedConfig));
  const cached = require.cache[require.resolve(path.join(root, 'config/index.ts'))];
  if (cached) assert.equal(cached.exports.configPath, ownedConfig);
}
if (worker !== undefined) {
  process.once('exit', () => record('worker-exit', {fixtureExists:fs.existsSync(ownedConfig)}));
}
exports.mochaHooks = {
  beforeEach() {
    if (worker === undefined) return;
    check();
    const file = this.currentTest.file;
    if (file !== lastFile) {
      lastFile = file;
      record('file-start', {file});
    }
  },
  afterAll() {
    if (worker === undefined) return;
    check();
    record('file-complete', {file:lastFile, fixtureExists:fs.existsSync(ownedConfig)});
  }
};
