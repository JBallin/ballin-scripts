const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testChildEnvironment, withEnvironment } = require('./helpers/environment.ts');

const repoRoot = path.resolve(__dirname, '..');

describe('test environment isolation', () => {
  it('normalizes setup before config imports and restores ambient values on teardown', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-environment-'));
    const setupPath = path.join(__dirname, 'setup.ts');
    const configModulePath = path.join(repoRoot, 'config', 'index.ts');
    const probe = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const setupPath = process.argv[1];
      const configModulePath = process.argv[2];
      const keys = [
        'CI', 'NODE_ENV', 'BALLIN_NO_ANALYTICS', 'BALLIN_NO_COMMAND_ANALYTICS',
        'BALLIN_TEST_CONFIG_PATH', 'BALLIN_BACKUP_HOST',
        'BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT', 'FAKE_BREW',
        'TEST_LOG_PATH', 'ANALYTICS_TEST_LOG_PATH',
      ];
      const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      assert.equal(require.cache[configModulePath], undefined);
      const setup = require(setupPath);
      const isolatedConfig = process.env.BALLIN_TEST_CONFIG_PATH;
      try {
        assert.equal(require.cache[configModulePath], undefined);
        assert.equal(process.env.NODE_ENV, 'test');
        assert.equal(process.env.CI, undefined);
        assert.equal(process.env.BALLIN_NO_ANALYTICS, '1');
        assert.equal(process.env.BALLIN_NO_COMMAND_ANALYTICS, undefined);
        for (const key of keys.slice(5)) assert.equal(process.env[key], undefined);
        assert.notEqual(isolatedConfig, original.BALLIN_TEST_CONFIG_PATH);
        assert.equal(fs.existsSync(isolatedConfig), true);
        const config = require(configModulePath);
        assert.equal(config.configPath, isolatedConfig);
        assert.deepEqual(
          config.fetchConfig().configObj,
          JSON.parse(fs.readFileSync(path.join(path.dirname(configModulePath), '.defaultConfig.json'), 'utf8')),
        );
      } finally {
        setup.mochaHooks.afterAll();
      }
      assert.equal(fs.existsSync(path.dirname(isolatedConfig)), false);
      for (const key of keys) assert.equal(process.env[key], original[key]);
    `;

    try {
      const selectors: NodeJS.ProcessEnv[] = [
        { CI: 'true', NODE_ENV: 'production', BALLIN_NO_ANALYTICS: '0', BALLIN_NO_COMMAND_ANALYTICS: '1' },
        {},
      ];
      for (const env of selectors) {
        const result = spawnSync(process.execPath, ['-e', probe, setupPath, configModulePath], {
          cwd: tempDir,
          encoding: 'utf8',
          env: {
            HOME: tempDir,
            TMPDIR: tempDir,
            PATH: path.dirname(process.execPath),
            BALLIN_TEST_CONFIG_PATH: path.join(tempDir, 'ambient-config.json'),
            BALLIN_BACKUP_HOST: 'ambient-host',
            BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1',
            FAKE_BREW: 'ambient-brew',
            TEST_LOG_PATH: path.join(tempDir, 'ambient-test.log'),
            ANALYTICS_TEST_LOG_PATH: path.join(tempDir, 'ambient-analytics.log'),
            ...env,
          },
        });
        assert.isUndefined(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readdirSync(tempDir), []);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds complete child environments with explicit overrides and coverage retention', () => {
    const configPath = process.env.BALLIN_TEST_CONFIG_PATH as string;
    const coveragePath = path.join(path.dirname(configPath), 'coverage-probe');
    withEnvironment({
      CI: 'true',
      BALLIN_NO_ANALYTICS: '0',
      BALLIN_NO_COMMAND_ANALYTICS: '1',
      BALLIN_BACKUP_HOST: 'ambient-host',
      BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1',
      FAKE_BREW: 'ambient-brew',
      TEST_LOG_PATH: 'ambient-log',
      ANALYTICS_TEST_LOG_PATH: 'ambient-analytics-log',
      NODE_OPTIONS: '--require=ambient-module',
      NODE_V8_COVERAGE: coveragePath,
    }, () => {
      assert.deepEqual(testChildEnvironment(), {
        HOME: path.dirname(configPath),
        PATH: path.dirname(process.execPath),
        NODE_ENV: 'test',
        BALLIN_TEST_CONFIG_PATH: configPath,
        BALLIN_NO_ANALYTICS: '1',
        NODE_V8_COVERAGE: coveragePath,
      });

      assert.deepEqual(testChildEnvironment({
        BALLIN_NO_ANALYTICS: undefined,
        CI: 'true',
        FAKE_BREW: 'fixture-brew',
        NODE_V8_COVERAGE: undefined,
      }), {
        HOME: path.dirname(configPath),
        PATH: path.dirname(process.execPath),
        NODE_ENV: 'test',
        BALLIN_TEST_CONFIG_PATH: configPath,
        CI: 'true',
        FAKE_BREW: 'fixture-brew',
      });
    });
    withEnvironment({ NODE_V8_COVERAGE: undefined }, () => {
      assert.notProperty(testChildEnvironment(), 'NODE_V8_COVERAGE');
    });
  });

  it('requires isolated setup before building child environments', () => {
    withEnvironment({ BALLIN_TEST_CONFIG_PATH: undefined }, () => {
      assert.throws(() => testChildEnvironment(), 'Load test/setup.ts');
    });
  });

  it('restores both absent and present scoped values after success or failure', () => {
    withEnvironment({ TEST_PRESENT: 'original', TEST_ABSENT: undefined }, () => {
      const result = withEnvironment({ TEST_PRESENT: undefined, TEST_ABSENT: 'temporary' }, () => {
        assert.notProperty(process.env, 'TEST_PRESENT');
        assert.equal(process.env.TEST_ABSENT, 'temporary');
        return 'completed';
      });
      assert.equal(result, 'completed');
      assert.equal(process.env.TEST_PRESENT, 'original');
      assert.notProperty(process.env, 'TEST_ABSENT');

      assert.throws(() => withEnvironment({ TEST_PRESENT: undefined, TEST_ABSENT: 'temporary' }, () => {
        throw new Error('simulated assertion failure');
      }), 'simulated assertion failure');
      assert.equal(process.env.TEST_PRESENT, 'original');
      assert.notProperty(process.env, 'TEST_ABSENT');
    });
  });
});
