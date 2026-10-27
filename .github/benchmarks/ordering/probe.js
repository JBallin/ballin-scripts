const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const exists = fs.existsSync.bind(fs);
const manifest = require(process.env.PERF_MANIFEST);
const source = fs.realpathSync(process.env.PERF_SOURCE);
const members = new Set(manifest.files.map(f => fs.realpathSync(path.resolve(source, f))));
const log = process.env.PERF_TRACE;
const emit = (kind, fields = {}) => append(log, JSON.stringify({ kind, time: Date.now(), pid: process.pid, worker: process.env.MOCHA_WORKER_ID, ...fields }) + '\n');
const Mocha = require(path.join(source, 'node_modules/mocha'));
const originalRun = Mocha.prototype.run;
let workerConfig;
Mocha.prototype.run = function(callback) {
  const files = this.files.map(f => fs.realpathSync(f));
  if (!files.some(f => members.has(f))) return originalRun.call(this, callback);
  const config = process.env.BALLIN_TEST_CONFIG_PATH;
  workerConfig ||= config;
  emit('file-start', { files, config, configExists: !!config && exists(config), stableConfig: config === workerConfig, coverage: process.env.NODE_V8_COVERAGE });
  return originalRun.call(this, function(...args) {
    emit('file-end', { files, config: process.env.BALLIN_TEST_CONFIG_PATH });
    return callback?.apply(this, args);
  });
};
const { BufferedWorkerPool } = require(path.join(source, 'node_modules/mocha/lib/nodejs/buffered-worker-pool.js'));
const originalDispatch = BufferedWorkerPool.prototype.run;
BufferedWorkerPool.prototype.run = function(file, ...args) {
  if (members.has(fs.realpathSync(file))) emit('enqueue', { file });
  return originalDispatch.call(this, file, ...args);
};
process.once('exit', () => emit('exit', { config: workerConfig, configExists: !!workerConfig && exists(workerConfig) }));
