const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testChildEnvironment } = require('./helpers/environment.ts');

const configPath = path.resolve(__dirname, '..', '.mocharc.js');
const mochaPath = require.resolve('mocha/bin/_mocha');

describe('Mocha worker selection', () => {
  for (const [cpus, jobs] of [[1, 1], [2, 1], [3, 1], [4, 2], [8, 2]]) {
    it(`uses ${jobs} job${jobs === 1 ? '' : 's'} with ${cpus} available CPUs`, () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-mocha-config-'));
      const preloadPath = path.join(tempDir, 'cpu.cjs');
      const fixturePath = path.join(tempDir, 'fixture.js');
      try {
        fs.writeFileSync(preloadPath, `
          const assert = require('node:assert/strict');
          require('node:os').availableParallelism = () => ${cpus};
          assert.equal(require(${JSON.stringify(configPath)}).jobs, ${jobs});
        `);
        fs.writeFileSync(fixturePath, `
          const assert = require('node:assert/strict');
          describe('isolated fixture', () => {
            it('uses the selected execution mode', () => {
              assert.equal(process.env.MOCHA_WORKER_ID !== undefined, ${jobs > 1});
            });
          });
        `);
        const result = spawnSync(process.execPath, [
          '--require', preloadPath, mochaPath,
          '--config', configPath, '--no-package', '--parallel',
          '--extension', 'js', '--reporter', 'dot', fixturePath,
        ], {
          cwd: tempDir,
          encoding: 'utf8',
          env: testChildEnvironment({ HOME: tempDir, TMPDIR: tempDir }),
          timeout: 8000,
        });
        assert.isUndefined(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.include(result.stdout, '1 passing');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

describe('default full-run ordering', () => {
  let root: string;
  let tracePath: string;
  let optionsPath: string;
  let preloadPath: string;
  type Observation = { name: string; worker?: string; pid: number; config: string };
  const names = ['quickstart.test.ts', 'a.test.ts', 'b.test.ts', 'repository_backup.test.ts', 'utility.ts', 'z.test.ts'];
  const nativeNames = (): string[] => require('mocha/lib/cli').lookupFiles(path.join(root, 'test'), ['ts']).map((file: string) => path.basename(file));
  const observations = (): Observation[] => fs.readFileSync(tracePath, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  const options = (): { jobs: number; spec?: string[] } => JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  const run = (cpus: number, args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    fs.writeFileSync(preloadPath, `
      require('node:os').availableParallelism = () => ${cpus};
      if (process.env.MOCHA_WORKER_ID === undefined) {
        process.once('exit', () => require('node:fs').writeFileSync(
          ${JSON.stringify(optionsPath)}, JSON.stringify(require.cache[${JSON.stringify(configPath)}].exports)
        ));
      }
    `);
    return spawnSync(process.execPath, ['--require', preloadPath, require.resolve('mocha/bin/mocha.js'), '--parallel', ...args], {
      cwd: root, encoding: 'utf8', timeout: 8000,
      env: testChildEnvironment({ HOME: root, TMPDIR: root, MOCHA_ORDER_LOG: tracePath, ...env }),
    });
  };
  const assertResult = (result: ReturnType<typeof spawnSync>, count: number, failures = 0) => {
    assert.isUndefined(result.error);
    assert.equal(result.status, failures ? 1 : 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stats.tests, count);
    assert.equal(report.stats.failures, failures);
    const observed = observations();
    assert.lengthOf(observed, count);
    assert.equal(new Set(observed.map(({ name }) => name)).size, count);
    // Cached production config must remain usable when a worker takes another file.
    for (const pid of new Set(observed.map(({ pid }) => pid))) {
      assert.equal(new Set(observed.filter((entry) => entry.pid === pid).map(({ config }) => config)).size, 1);
    }
    const configs = [...new Set(observed.map(({ config }) => config))];
    assert.equal(configs.length, new Set(observed.map(({ pid }) => pid)).size);
    configs.forEach((config) => assert.isFalse(fs.existsSync(path.dirname(config)), 'worker config must be cleaned up'));
    return observed;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-mocha-order-'));
    tracePath = path.join(root, 'observed.jsonl');
    optionsPath = path.join(root, 'options.json');
    preloadPath = path.join(root, 'cpu.cjs');
    fs.mkdirSync(path.join(root, 'test', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mocharc.js'), `module.exports = require(${JSON.stringify(configPath)});`);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ mocha: {
      extension: ['ts'], reporter: 'json',
      require: [require.resolve('chai/register-assert.js'), path.join(__dirname, 'setup.ts')],
    } }));
    for (const name of names) {
      fs.writeFileSync(path.join(root, 'test', name), `
        const fs = require('node:fs');
        const config = require(${JSON.stringify(path.join(__dirname, '..', 'config', 'index.ts'))});
        describe(${JSON.stringify(name)}, () => {
          it('keeps worker state isolated', async () => {
            assert.isTrue(fs.existsSync(config.configPath));
            assert.deepEqual(config.fetchConfig().configObj, JSON.parse(fs.readFileSync(config.configPath, 'utf8')));
            fs.appendFileSync(process.env.MOCHA_ORDER_LOG, JSON.stringify({
              name: ${JSON.stringify(name)}, worker: process.env.MOCHA_WORKER_ID,
              pid: process.pid, config: config.configPath,
            }) + '\\n');
            assert.notEqual(process.env.MOCHA_ORDER_FAIL, ${JSON.stringify(name)}, 'intentional fixture failure');
            await new Promise(resolve => setTimeout(resolve, 20));
          });
        });
      `);
    }
    // Native discovery excludes alternate extensions, hidden files and nested tests.
    for (const name of ['other.js', 'other.cjs', 'other.mjs', '.hidden.ts', 'nested/hidden.test.ts']) {
      fs.writeFileSync(path.join(root, 'test', name), 'throw new Error("unexpected discovery");');
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('queues lifecycle then Quickstart with every native file once and safely reuses workers', () => {
    const observed = assertResult(run(4), names.length);
    assert.deepEqual(options(), { jobs: 2, spec: [
      'test/repository_backup.test.ts', 'test/quickstart.test.ts', ...nativeNames().filter((name) => !['repository_backup.test.ts', 'quickstart.test.ts'].includes(name)).map((name) => path.join('test', name)),
    ] });
    assert.equal(observed.find(({ name }) => name === 'repository_backup.test.ts')?.worker, '0');
    assert.equal(new Set(observed.map(({ pid }) => pid)).size, 2);
    assert.sameMembers(observed.map(({ name }) => name), names);
  });
  it('retains native serial discovery and order on smaller hosts', () => {
    const observed = assertResult(run(2), names.length);
    assert.deepEqual(options(), { jobs: 1 });
    assert.deepEqual(observed.map(({ name }) => name), nativeNames());
    observed.forEach(({ worker }) => assert.isUndefined(worker));
  });
  for (const args of [['test/b.test.ts'], ['test/b.test.ts', 'test/b.test.ts'], ['--grep', '^b\\.test\\.ts ']]) {
    it(`preserves focused selection ${JSON.stringify(args)}`, () => {
      assert.deepEqual(assertResult(run(4, args), 1).map(({ name }) => name), ['b.test.ts']);
      assert.deepEqual(options(), { jobs: 2 });
    });
  }
  for (const args of [['--no-parallel'], ['--jobs', '1']]) {
    it(`preserves explicit serial override ${JSON.stringify(args)}`, () => {
      const observed = assertResult(run(4, args), names.length);
      assert.deepEqual(options(), { jobs: 2 });
      assert.deepEqual(observed.map(({ name }) => name), nativeNames());
      observed.forEach(({ worker }) => assert.isUndefined(worker));
    });
  }
  it('leaves environment-provided selection and worker overrides to Mocha', () => {
    const observed = assertResult(run(4, [], { MOCHA_OPTIONS: '--spec test/b.test.ts --jobs 1' }), 1);
    assert.deepEqual(options(), { jobs: 2 });
    assert.equal(observed[0].name, 'b.test.ts');
    assert.isUndefined(observed[0].worker);
  });
  it('does not invent a missing Quickstart file', () => {
    fs.unlinkSync(path.join(root, 'test', 'quickstart.test.ts'));
    assertResult(run(4), names.length - 1);
    assert.deepEqual(options().spec, ['test/repository_backup.test.ts', ...nativeNames().filter((name) => name !== 'repository_backup.test.ts').map((name) => path.join('test', name))]);
  });
  it('does not invent or duplicate a missing lifecycle file', () => {
    fs.unlinkSync(path.join(root, 'test', 'repository_backup.test.ts'));
    assertResult(run(4), names.length - 1);
    assert.deepEqual(options().spec, ['test/quickstart.test.ts', ...nativeNames().filter((name) => name !== 'quickstart.test.ts').map((name) => path.join('test', name))]);
  });
  it('retains a failing default-run result and the remaining test cases', () => {
    assertResult(run(4, [], { MOCHA_ORDER_FAIL: 'repository_backup.test.ts' }), names.length, 1);
  });
});
