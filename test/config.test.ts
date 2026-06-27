const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const defaultConfig = require('../config/.defaultConfig.json');
const configModule = require('../config/index.ts');

const {
  getConfig,
  setConfig,
  configAction,
  configPath,
  fetchConfig,
  configMessages,
} = configModule;

type SpawnArgs = string[];

const fetchConfigJSON = () => fetchConfig().configJSON;
const cliPath = path.join(__dirname, '..', 'bin', 'ballin_config');

const currentConfigJSON = fetchConfigJSON();
const invalidPathCases = [
  ['missing', 'missing'],
  ['test.nested', 'test'],
  ['gu.missing.nested', 'gu.missing'],
  ['up.cleanup.nested', 'up.cleanup.nested'],
  ['up.cleanup.nested.deeper', 'up.cleanup.nested'],
  ['gu.id.nested', 'gu.id.nested'],
  ['gu.id.nested.deeper', 'gu.id.nested'],
  ['constructor', 'constructor'],
  ['__proto__.nested', '__proto__'],
];

const setTest = (keys: string, value: string, action = setConfig) => {
  action(keys, value);
  assert.deepEqual(value, getConfig(keys));
};

const setConfigAction = (keys: string, value: string) => configAction('set', keys, value);

const runConfigCli = (args: SpawnArgs = []) => spawnSync(process.execPath, [cliPath, ...args], {
  encoding: 'utf8',
  env: process.env,
});

describe('config', () => {
  let savedConfig: string;

  it('uses the isolated test config fixture', () => {
    assert.equal(configPath, process.env.BALLIN_TEST_CONFIG_PATH);
    assert.notEqual(configPath, path.join(__dirname, '..', 'ballin.config.json'));
  });

  it('loads the TypeScript config implementation directly', () => {
    assert.equal(configModule.configPath, configPath);
    assert.strictEqual(configModule.getConfig, getConfig);
  });

  it('does not treat NODE_ENV=test as a fixture run by itself', () => {
    const result = spawnSync(process.execPath, ['-p', "require('./config/index.ts').configPath"], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        BALLIN_TEST_CONFIG_PATH: '',
        NODE_ENV: 'test',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), path.join(__dirname, '..', 'ballin.config.json'));
  });

  before('fetchConfigJSON should return a String', () => {
    assert.isString(fetchConfigJSON());
  });
  after('tests shouldn\'t alter config', () => {
    assert.equal(currentConfigJSON, fetchConfigJSON());
  });
  beforeEach('Save config', () => {
    savedConfig = fetchConfigJSON();
    assert.isString(savedConfig);
  });
  afterEach('Reset config', () => {
    fs.writeFileSync(configPath, savedConfig, 'utf8');
  });

  describe('getConfig', () => {
    it('("up") should return an Object', () => {
      assert.isObject(getConfig('up'));
    });
    it('("gu.id") should return null by default', () => {
      assert.isNull(getConfig('gu.id'));
    });
    it('("gu.host") should return github.com by default', () => {
      assert.equal(getConfig('gu.host'), 'github.com');
    });
    it('("up.cleanup") should return true or false', () => {
      assert.include(['true', 'false'], getConfig('up.cleanup'));
    });
    it('() should return a String', () => {
      assert.isString(getConfig());
    });
    invalidPathCases.forEach(([keys, missingKeys]) => {
      it(`should report "${missingKeys}" for invalid path "${keys}"`, () => {
        assert.equal(getConfig(keys), configMessages.getKeysDneErr(missingKeys));
      });
    });
    it('should reject traversal through every JSON primitive type', () => {
      const configObj = JSON.parse(fetchConfigJSON());
      configObj.testValues = {
        boolean: false,
        number: 0,
        string: 'value',
        null: null,
      };
      fs.writeFileSync(configPath, JSON.stringify(configObj), 'utf8');

      ['boolean', 'number', 'string', 'null'].forEach((key) => {
        const keys = `testValues.${key}.nested`;
        assert.equal(getConfig(keys), configMessages.getKeysDneErr(keys));
      });
    });
  });

  describe('setConfig', () => {
    const initialConfig = fetchConfigJSON();

    after('setConfig tests shouldn\'t alter config', () => {
      assert.equal(fetchConfigJSON(), initialConfig);
    });

    it('should set up.cleanup', () => {
      setTest('up.cleanup', 'test');
    });
    it('should set gu.id', () => {
      setTest('gu.id', '123');
    });
    it('should give error if given no arguments', () => {
      assert.equal(setConfig(), configMessages.setArgsErr);
    });
    it('should give error if given 3 arguments', () => {
      assert.equal(setConfig('a', 'b', ['c']), configMessages.setArgsErr);
    });
    it('should return the keys/value it set', () => {
      const keys = 'up.cleanup';
      const val = 'true';
      assert.equal(setConfig(keys, val), `"${keys}" set to: "${val}"`);
    });
    it('should give error if trying to write to an object', () => {
      const keys = 'up';
      const val = 'true';
      assert.include(setConfig(keys, val), 'INVALID: "up" is not a bottom-level value, it returns');
    });
    invalidPathCases.forEach(([keys, missingKeys]) => {
      it(`should reject invalid path "${keys}" without changing config`, () => {
        const configBeforeSet = fetchConfigJSON();

        assert.equal(setConfig(keys, 'test'), configMessages.setDneErr(missingKeys));
        assert.equal(fetchConfigJSON(), configBeforeSet);
      });
    });
    it('should reject every JSON primitive type without changing config', () => {
      const configObj = JSON.parse(fetchConfigJSON());
      configObj.testValues = {
        boolean: false,
        number: 0,
        string: 'value',
        null: null,
      };
      fs.writeFileSync(configPath, JSON.stringify(configObj), 'utf8');
      const configBeforeSet = fetchConfigJSON();

      ['boolean', 'number', 'string', 'null'].forEach((key) => {
        const keys = `testValues.${key}.nested`;
        assert.equal(setConfig(keys, 'test'), configMessages.setDneErr(keys));
        assert.equal(fetchConfigJSON(), configBeforeSet);
      });
    });
  });

  it('CLI invalid get/set commands exit cleanly without changing config', () => {
    const configBeforeSet = fetchConfigJSON();
    const getResult = runConfigCli(['get', 'up.nvm.nested']);
    const setResult = runConfigCli(['set', 'up.nvm.nested', 'test']);
    const expectedOutput = `${configMessages.getKeysDneErr('up.nvm.nested')}\n`;

    assert.equal(getResult.status, 0);
    assert.equal(getResult.stdout, expectedOutput);
    assert.equal(getResult.stderr, '');
    assert.equal(setResult.status, 0);
    assert.equal(setResult.stdout, expectedOutput);
    assert.equal(setResult.stderr, '');
    assert.equal(fetchConfigJSON(), configBeforeSet);
  });

  it('CLI prints the full config when called without arguments', () => {
    const result = runConfigCli();

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${fetchConfigJSON()}\n`);
    assert.equal(result.stderr, '');
  });

  it('CLI remains executable through its shebang', () => {
    const result = spawnSync(cliPath, ['get', 'gu.id'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'null\n');
    assert.equal(result.stderr, '');
  });

  it('CLI remains executable through the installed symlink model', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-bin-'));
    const symlinkPath = path.join(tempDir, 'ballin_config');

    try {
      fs.symlinkSync(cliPath, symlinkPath);

      const result = spawnSync(symlinkPath, ['get', 'gu.id'], {
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'null\n');
      assert.equal(result.stderr, '');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('CLI reset restores the default config', () => {
    setConfig('gu.id', 'changed-id');

    const result = runConfigCli(['reset']);

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Config has been reset...\nFROM:');
    assert.isNull(getConfig('gu.id'));
    assert.deepEqual(fetchConfig().configObj, defaultConfig);
  });

  it('CLI invalid action exits cleanly in test mode', () => {
    const result = runConfigCli(['wrong']);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${configMessages.actionErr}\n`);
    assert.equal(result.stderr, '');
  });

  describe('configAction', () => {
    it('() should return a String', () => {
      assert.isString(configAction('get'));
    });
    it('("get") should return a String', () => {
      assert.isString(configAction('get'));
    });
    it('("set") should return a setConfig error', () => {
      assert.equal(configAction('set'), configMessages.setArgsErr);
    });
    it('("get", "gu.id") should return null by default', () => {
      assert.isNull(configAction('get', 'gu.id'));
    });
    it('("wrong") should return an invalid error', () => {
      assert.equal(configAction('wrong'), configMessages.actionErr);
    });
    it('("set", "gu.id", "123") should set gu.id to "123"', () => {
      setTest('gu.id', '123', setConfigAction);
    });
    it('("reset") should reset config', () => {
      setTest('gu.id', '123', setConfigAction);
      assert.include(configAction('reset'), 'Config has been reset...\nFROM:');
      assert.isNull(getConfig('gu.id'));
    });
  });

  describe('updateConfig', () => {
    it('updates the isolated fixture when required directly', () => {
      fs.writeFileSync(configPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, ['-e', "require('./config/updateConfig.ts')"], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(fetchConfig().configObj, defaultConfig);
    });

    it('updates the isolated fixture when invoked through updateConfig.ts', () => {
      fs.writeFileSync(configPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'config', 'updateConfig.ts')], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(fetchConfig().configObj, defaultConfig);
    });

    it('derives gu.host from a legacy Enterprise Gist URL', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        up: defaultConfig.up,
        gu: {
          id: 'enterprise-gist-id',
          url: 'https://gist.github.example.test',
          token_file: '.legacy-gist-token',
        },
      }), 'utf8');

      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'config', 'updateConfig.ts')], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.equal(getConfig('gu.host'), 'github.example.test');
      assert.equal(getConfig('gu.url'), 'https://gist.github.example.test');
      assert.equal(getConfig('gu.token_file'), '.legacy-gist-token');
    });

    it('maps the legacy github.com Gist URL to the GitHub host', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        up: defaultConfig.up,
        gu: {
          id: 'github-gist-id',
          url: 'https://gist.github.com',
        },
      }), 'utf8');

      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'config', 'updateConfig.ts')], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.equal(getConfig('gu.host'), 'github.com');
    });
  });
});
