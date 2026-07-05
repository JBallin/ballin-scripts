const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const defaultConfig = require('../config/.defaultConfig.json');
const configModule = require('../config/index.ts');
const {
  createConfigStore,
} = require('../config/store.ts');

const {
  getConfig,
  setConfig,
  configAction,
  configPath,
  fetchConfig,
  configMessages,
  stringify,
} = configModule;

type SpawnArgs = string[];

const fetchConfigJSON = () => fetchConfig().configJSON;
const cliPath = path.join(__dirname, '..', 'bin', 'ballin');

const currentConfigJSON = fetchConfigJSON();
const invalidPathCases = [
  ['missing', 'missing'],
  ['test.nested', 'test'],
  ['backup.missing.nested', 'backup.missing'],
  ['update.cleanup.nested', 'update.cleanup.nested'],
  ['update.cleanup.nested.deeper', 'update.cleanup.nested'],
  ['backup.id.nested', 'backup.id.nested'],
  ['backup.id.nested.deeper', 'backup.id.nested'],
  ['constructor', 'constructor'],
  ['__proto__.nested', '__proto__'],
];

const setTest = (keys: string, value: string, action = setConfig) => {
  action(keys, value);
  assert.deepEqual(value, getConfig(keys));
};

const setConfigAction = (keys: string, value: string) => configAction('set', keys, value);

const runConfigCli = (args: SpawnArgs = []) => spawnSync(process.execPath, [cliPath, 'config', ...args], {
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

  describe('path-scoped config store', () => {
    let tempDir: string;
    let explicitConfigPath: string;
    const explicitDefaultConfigPath = path.join(__dirname, '..', 'config', '.defaultConfig.json');

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-store-'));
      explicitConfigPath = path.join(tempDir, 'ballin.config.json');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const writeExplicitConfig = (config: unknown) => {
      fs.writeFileSync(explicitConfigPath, stringify(config), 'utf8');
      return createConfigStore({
        configPath: explicitConfigPath,
        defaultConfigPath: explicitDefaultConfigPath,
      });
    };

    it('reads and writes an explicit config path independently from the default fixture', () => {
      const store = writeExplicitConfig({
        ...defaultConfig,
        backup: {
          ...defaultConfig.backup,
          id: 'explicit-gist-id',
        },
      });

      assert.notEqual(explicitConfigPath, configPath);
      assert.equal(store.readLeafValue('backup.id'), 'explicit-gist-id');
      assert.isNull(getConfig('backup.id'));
      assert.isTrue(store.writeLeafValue('backup.host', 'github.explicit.test'));
      assert.equal(JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8')).backup.host, 'github.explicit.test');
      assert.equal(getConfig('backup.host'), 'github.com');
    });

    it('preserves nested path validation for explicit-path reads and writes', () => {
      const store = writeExplicitConfig(defaultConfig);
      const configBeforeWrite = fs.readFileSync(explicitConfigPath, 'utf8');

      assert.isUndefined(store.readLeafValue('missing'));
      assert.isUndefined(store.readLeafValue('constructor'));
      assert.isUndefined(store.readLeafValue('__proto__.nested'));
      assert.isUndefined(store.readLeafValue('update'));
      assert.isFalse(store.writeLeafValue('missing', 'value'));
      assert.isFalse(store.writeLeafValue('constructor', 'value'));
      assert.isFalse(store.writeLeafValue('__proto__.nested', 'value'));
      assert.isFalse(store.writeLeafValue('update', 'value'));
      assert.equal(fs.readFileSync(explicitConfigPath, 'utf8'), configBeforeWrite);
    });

    it('returns leaf values and rejects malformed explicit config files without mutating them', () => {
      const store = writeExplicitConfig(defaultConfig);

      assert.isNull(store.readLeafValue('backup.id'));
      assert.equal(store.readLeafValue('backup.host'), 'github.com');

      fs.writeFileSync(explicitConfigPath, '{not json\n', 'utf8');
      assert.isUndefined(store.readLeafValue('backup.host'));
      assert.isFalse(store.writeLeafValue('backup.host', 'github.example.test'));
      assert.equal(fs.readFileSync(explicitConfigPath, 'utf8'), '{not json\n');
    });
  });

  describe('getConfig', () => {
    it('("update") should return an Object', () => {
      assert.isObject(getConfig('update'));
    });
    it('("backup.id") should return null by default', () => {
      assert.isNull(getConfig('backup.id'));
    });
    it('("backup.host") should return github.com by default', () => {
      assert.equal(getConfig('backup.host'), 'github.com');
    });
    it('("update.cleanup") should return true or false', () => {
      assert.include(['true', 'false'], getConfig('update.cleanup'));
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

    it('should set update.cleanup', () => {
      setTest('update.cleanup', 'test');
    });
    it('should set backup.id', () => {
      setTest('backup.id', '123');
    });
    it('should give error if given no arguments', () => {
      assert.equal(setConfig(), configMessages.setArgsErr);
    });
    it('should give error if given 3 arguments', () => {
      assert.equal(setConfig('a', 'b', ['c']), configMessages.setArgsErr);
    });
    it('should return the keys/value it set', () => {
      const keys = 'update.cleanup';
      const val = 'true';
      assert.equal(setConfig(keys, val), `"${keys}" set to: "${val}"`);
    });
    it('should give error if trying to write to an object', () => {
      const keys = 'update';
      const val = 'true';
      assert.include(setConfig(keys, val), 'INVALID: "update" is not a bottom-level value, it returns');
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
    const getResult = runConfigCli(['get', 'update.nvm.nested']);
    const setResult = runConfigCli(['set', 'update.nvm.nested', 'test']);
    const expectedOutput = `${configMessages.getKeysDneErr('update.nvm.nested')}\n`;

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
    const result = spawnSync(cliPath, ['config', 'get', 'backup.id'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'null\n');
    assert.equal(result.stderr, '');
  });

  it('CLI remains executable through the installed symlink model', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-bin-'));
    const symlinkPath = path.join(tempDir, 'ballin');

    try {
      fs.symlinkSync(cliPath, symlinkPath);

      const result = spawnSync(symlinkPath, ['config', 'get', 'backup.id'], {
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
    setConfig('backup.id', 'changed-id');
    const changedConfig = fetchConfigJSON();

    const result = runConfigCli(['reset']);

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Config has been reset...\nFROM:');
    assert.include(result.stdout, changedConfig);
    assert.isNull(getConfig('backup.id'));
    assert.deepEqual(fetchConfig().configObj, defaultConfig);
  });

  it('CLI reset recreates the default config when the config file is missing', () => {
    fs.rmSync(configPath);

    const result = runConfigCli(['reset']);

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Config has been reset...\nFROM:');
    assert.include(result.stdout, `Unable to read ${configPath}.`);
    assert.deepEqual(fetchConfig().configObj, defaultConfig);
    assert.equal(result.stderr, '');
  });

  it('CLI reset recreates the default config when the config file is malformed JSON', () => {
    fs.writeFileSync(configPath, '{not json\n', 'utf8');

    const result = runConfigCli(['reset']);

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Config has been reset...\nFROM:\n{not json\nTO:\n');
    assert.deepEqual(fetchConfig().configObj, defaultConfig);
    assert.equal(result.stderr, '');
  });

  [
    ['array', '[]\n'],
    ['null', 'null\n'],
    ['string', '"not object"\n'],
  ].forEach(([name, configContents]) => {
    it(`CLI reset recreates the default config when the config parses to ${name}`, () => {
      fs.writeFileSync(configPath, configContents, 'utf8');

      const result = runConfigCli(['reset']);

      assert.equal(result.status, 0);
      assert.include(result.stdout, `Config has been reset...\nFROM:\n${configContents}TO:\n`);
      assert.deepEqual(fetchConfig().configObj, defaultConfig);
      assert.equal(result.stderr, '');
    });
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
    it('("get", "backup.id") should return null by default', () => {
      assert.isNull(configAction('get', 'backup.id'));
    });
    it('("wrong") should return an invalid error', () => {
      assert.equal(configAction('wrong'), configMessages.actionErr);
    });
    it('("set", "backup.id", "123") should set backup.id to "123"', () => {
      setTest('backup.id', '123', setConfigAction);
    });
    it('("reset") should reset config', () => {
      setTest('backup.id', '123', setConfigAction);
      assert.include(configAction('reset'), 'Config has been reset...\nFROM:');
      assert.isNull(getConfig('backup.id'));
    });
  });

  describe('updateConfig', () => {
    const updateConfigPath = path.join(__dirname, '..', 'config', 'updateConfig.ts');
    const runUpdateConfig = () => spawnSync(process.execPath, [updateConfigPath], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: process.env,
    });

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

      const result = runUpdateConfig();

      assert.equal(result.status, 0);
      assert.deepEqual(fetchConfig().configObj, defaultConfig);
    });

    it('adds missing nested analytics defaults without overwriting existing choices', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        analytics: {
          enabled: 'false',
        },
      }), 'utf8');

      const result = runUpdateConfig();

      assert.equal(result.status, 0);
      assert.deepEqual(fetchConfig().configObj.analytics, {
        enabled: 'false',
      });
    });

    [
      {
        name: 'backup: null',
        config: { ...defaultConfig, backup: null },
        key: 'backup',
      },
      {
        name: 'backup: "bad"',
        config: { ...defaultConfig, backup: 'bad' },
        key: 'backup',
      },
      {
        name: 'update: false',
        config: { ...defaultConfig, update: false },
        key: 'update',
      },
      {
        name: 'analytics: false',
        config: { ...defaultConfig, analytics: false },
        key: 'analytics',
      },
    ].forEach(({ name, config, key }) => {
      it(`replaces malformed object-shaped config section ${name}`, () => {
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const result = runUpdateConfig();

        assert.equal(result.status, 0);
        assert.deepEqual(fetchConfig().configObj, defaultConfig);
        assert.include(result.stdout, `${key}: ${JSON.stringify(defaultConfig[key])}`);
      });
    });

    it('preserves renamed config values when adding missing defaults', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        update: {
          cleanup: 'new-cleanup',
          selfUpdate: 'new-self-update',
        },
        backup: {
          id: 'new-gist-id',
          host: 'new.example.test',
        },
        analytics: {
          enabled: 'false',
        },
      }), 'utf8');

      const result = runUpdateConfig();

      assert.equal(result.status, 0);
      assert.equal(getConfig('update.cleanup'), 'new-cleanup');
      assert.equal(getConfig('update.selfUpdate'), 'new-self-update');
      assert.equal(getConfig('update.backup'), defaultConfig.update.backup);
      assert.equal(getConfig('backup.id'), 'new-gist-id');
      assert.equal(getConfig('backup.host'), 'new.example.test');
    });
  });
});
