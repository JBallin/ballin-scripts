const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');
const defaultConfig = require('../config/.defaultConfig.json');
const configModule = require('../config/index.ts');
const { configHelp, runConfigCli: executeConfigCli } = require('../config/cli.ts');
const {
  ConfigError,
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

const setConfigAction = (keys: string, value: string) => configAction(['set', keys, value]);

const runConfigCli = (args: SpawnArgs = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cliPath, 'config', ...args], {
  encoding: 'utf8',
  env: testChildEnvironment(env),
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
      env: testChildEnvironment({ BALLIN_TEST_CONFIG_PATH: '' }),
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

    it('rejects missing or invalid bundled defaults before reset writes user config', () => {
      const store = writeExplicitConfig(defaultConfig);
      const before = fs.readFileSync(explicitConfigPath, 'utf8');
      const defaultsPath = path.join(tempDir, 'defaults.json');
      const resetStore = createConfigStore({ configPath: explicitConfigPath, defaultConfigPath: defaultsPath });
      assert.throws(() => resetStore.resetConfig(), ConfigError, 'Unable to read bundled default config.');
      for (const contents of ['{not json', 'null', '[]']) {
        fs.writeFileSync(defaultsPath, contents);
        const error = assert.throws(() => resetStore.resetConfig(), ConfigError,
          'Check the Ballin installation\'s bundled default config.');
        assert.propertyVal(error, 'exitCode', 1);
        assert.notInclude(String(error), defaultsPath);
        assert.equal(fs.readFileSync(explicitConfigPath, 'utf8'), before);
      }
      assert.equal(store.readLeafValue('backup.host'), 'github.com');
    });

    it('rejects direct get/set usage before reading config and preserves leaf-helper failures', () => {
      const store = createConfigStore({ configPath: explicitConfigPath });
      for (const action of [() => store.getConfig('key', ''), () => store.setConfig()]) {
        const error = assert.throws(action, ConfigError);
        assert.propertyVal(error, 'exitCode', 2);
      }
      fs.writeFileSync(explicitConfigPath, 'null');
      assert.isUndefined(store.readLeafValue('backup.id'));
      assert.isFalse(store.writeLeafValue('backup.id', 'value'));
      assert.equal(fs.readFileSync(explicitConfigPath, 'utf8'), 'null');
    });

    it('preserves numeric and boolean leaves without requiring setting-specific validation', () => {
      const store = writeExplicitConfig({ values: { boolean: false, number: 0 } });
      assert.strictEqual(store.readLeafValue('values.boolean'), false);
      assert.strictEqual(store.readLeafValue('values.number'), 0);
      assert.isTrue(store.writeLeafValue('values.boolean', true));
      assert.isTrue(store.writeLeafValue('values.number', 42));
      assert.strictEqual(store.getConfig('values.boolean'), true);
      assert.strictEqual(store.getConfig('values.number'), 42);
    });

    it('does not disguise programming errors as expected configuration failures', () => {
      const store = writeExplicitConfig(defaultConfig);
      const previousExitCode = process.exitCode;
      const cases = [
        { owner: fs, method: 'readFileSync', action: () => executeConfigCli(['get']) },
        { owner: fs, method: 'readFileSync', action: () => store.resetConfig() },
        { owner: fs, method: 'writeFileSync', action: () => store.setConfig('backup.id', 'value') },
        { owner: JSON, method: 'parse', action: () => store.getConfig() },
      ];
      try {
        for (const failure of [
          new TypeError('unexpected programming error'),
          Object.assign(new TypeError('invalid API argument'), { code: 'ERR_INVALID_ARG_TYPE' }),
        ]) {
          for (const { owner, method, action } of cases) {
            const original = owner[method];
            owner[method] = () => { throw failure; };
            let caught: unknown;
            try {
              action();
            } catch (error) {
              caught = error;
            } finally {
              owner[method] = original;
            }
            assert.strictEqual(caught, failure);
          }
        }
      } finally {
        process.exitCode = previousExitCode;
      }
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
        assert.throws(() => getConfig(keys), ConfigError, configMessages.getKeysDneErr(missingKeys));
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
        assert.throws(() => getConfig(keys), ConfigError, configMessages.getKeysDneErr(keys));
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
      assert.throws(() => setConfig(), ConfigError, configMessages.setArgsErr);
    });
    it('should give error if given 3 arguments', () => {
      assert.throws(() => setConfig('a', 'b', ['c']), ConfigError, configMessages.setArgsErr);
    });
    it('should return the keys/value it set', () => {
      const keys = 'update.cleanup';
      const val = 'true';
      assert.equal(setConfig(keys, val), `"${keys}" set to: "${val}"`);
    });
    it('should give error if trying to write to an object', () => {
      const keys = 'update';
      const val = 'true';
      assert.throws(() => setConfig(keys, val), ConfigError, configMessages.setObjErr(keys));
    });
    invalidPathCases.forEach(([keys, missingKeys]) => {
      it(`should reject invalid path "${keys}" without changing config`, () => {
        const configBeforeSet = fetchConfigJSON();

        assert.throws(() => setConfig(keys, 'test'), ConfigError, configMessages.setDneErr(missingKeys));
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
        assert.throws(() => setConfig(keys, 'test'), ConfigError, configMessages.setDneErr(keys));
        assert.equal(fetchConfigJSON(), configBeforeSet);
      });
    });
  });

  it('CLI invalid get/set commands fail on stderr without changing config', () => {
    const configBeforeSet = fetchConfigJSON();
    const getResult = runConfigCli(['get', 'update.nvm.nested']);
    const setResult = runConfigCli(['set', 'update.nvm.nested', 'test']);
    const expectedOutput = `ballin config: ${configMessages.getKeysDneErr('update.nvm.nested')}\n`;

    assert.equal(getResult.status, 1);
    assert.equal(getResult.stdout, '');
    assert.equal(getResult.stderr, expectedOutput);
    assert.equal(setResult.status, 1);
    assert.equal(setResult.stdout, '');
    assert.equal(setResult.stderr, expectedOutput);
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
      env: testChildEnvironment(),
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
        env: testChildEnvironment(),
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
    assert.include(result.stdout, 'Unable to read previous config.');
    assert.notInclude(result.stdout, configPath);
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

  it('CLI invalid action prints deterministic help without a child in either environment', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-help-'));
    const childLogPath = path.join(tempDir, 'child.log');
    fs.writeFileSync(path.join(tempDir, 'ballin'), `#!/bin/sh
printf 'called' > "$BALLIN_CONFIG_HELP_LOG"
`, { mode: 0o755 });

    try {
      for (const nodeEnv of ['test', 'production']) {
        const result = runConfigCli(['wrong'], {
          PATH: tempDir,
          NODE_ENV: nodeEnv,
          BALLIN_CONFIG_HELP_LOG: childLogPath,
        });
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `ballin config: ${configMessages.actionErr}\n${configHelp}`);
        assert.isFalse(fs.existsSync(childLogPath));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('CLI error contract', () => {
    const usageCases = [
      { args: ['wrong'], message: configMessages.actionErr },
      { args: ['get', 'backup.id', ''], message: configMessages.getArgsErr },
      { args: ['', 'backup.id', '', 'extra'], message: configMessages.getArgsErr },
      { args: ['set'], message: configMessages.setArgsErr },
      { args: ['set', 'backup.id'], message: configMessages.setArgsErr },
      { args: ['set', '', 'value'], message: configMessages.setArgsErr },
      { args: ['set', 'backup.id', 'value', ''], message: configMessages.setArgsErr },
      { args: ['reset', ''], message: configMessages.resetArgsErr },
      { args: ['help', 'extra'], message: configMessages.actionErr },
      { args: ['--help', 'extra'], message: configMessages.actionErr },
    ];

    usageCases.forEach(({ args, message }) => {
      it(`rejects ${JSON.stringify(args)} before reading malformed config`, () => {
        const malformed = '{private malformed contents';
        fs.writeFileSync(configPath, malformed);
        const result = runConfigCli(args);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `ballin config: ${message}\n${configHelp}`);
        assert.equal(fs.readFileSync(configPath, 'utf8'), malformed);
      });
    });

    ['help', '--help'].forEach((action) => {
      it(`prints ${action} without reading missing, malformed, or unreadable config`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-help-read-'));
        const malformedPath = path.join(tempDir, 'malformed.json');
        fs.writeFileSync(malformedPath, '{not json');
        try {
          for (const fixturePath of [path.join(tempDir, 'missing.json'), malformedPath, tempDir]) {
            const result = runConfigCli([action], { BALLIN_TEST_CONFIG_PATH: fixturePath });
            assert.equal(result.status, 0);
            assert.equal(result.stdout, configHelp);
            assert.equal(result.stderr, '');
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    [
      { contents: '{private malformed contents', reason: 'Config is not valid JSON.' },
      ...['null', '[]', '"private value"', 'false', '42'].map((contents) => ({
        contents, reason: 'Config must contain a JSON object.',
      })),
    ].forEach(({ contents, reason }) => {
      it(`rejects invalid config ${contents} for full reads, keyed reads, and writes`, () => {
        fs.writeFileSync(configPath, contents);
        for (const args of [[], ['get', 'backup.id'], ['set', 'backup.id', 'changed']]) {
          const result = runConfigCli(args);
          assert.equal(result.status, 1);
          assert.equal(result.stdout, '');
          assert.equal(result.stderr, `ballin config: ${reason} Run ballin config reset to restore defaults.\n`);
          assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
        }
      });
    });

    it('reports missing and unreadable files without paths or stacks', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-read-'));
      try {
        for (const args of [['get'], ['set', 'backup.id', 'value']]) {
          const missing = runConfigCli(args, { BALLIN_TEST_CONFIG_PATH: path.join(tempDir, 'missing.json') });
          assert.equal(missing.status, 1);
          assert.equal(missing.stdout, '');
          assert.equal(missing.stderr, 'ballin config: Unable to read config. Run ballin config reset to restore defaults.\n');

          const unreadable = runConfigCli(args, { BALLIN_TEST_CONFIG_PATH: tempDir });
          assert.equal(unreadable.status, 1);
          assert.equal(unreadable.stdout, '');
          assert.equal(unreadable.stderr, 'ballin config: Unable to read config. Check that the config file is accessible and readable.\n');
        }
        const reset = runConfigCli(['reset'], { BALLIN_TEST_CONFIG_PATH: tempDir });
        assert.equal(reset.status, 1);
        assert.equal(reset.stdout, '');
        assert.equal(reset.stderr, 'ballin config: Unable to save config. Check that the config file and its parent directory are writable.\n');
        assert.deepEqual(fs.readdirSync(tempDir), []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('reports write failures and oversized config reads from the public CLI without printing success', () => {
      const before = fetchConfigJSON();
      const writeMessage = 'Unable to save config. Check that the config file and its parent directory are writable.';
      const cases = [
        { args: ['set', 'backup.id', 'changed'], method: 'writeFileSync', code: 'EACCES', message: writeMessage },
        { args: ['reset'], method: 'writeFileSync', code: 'EACCES', message: writeMessage },
        {
          args: ['get'], method: 'readFileSync', code: 'ERR_FS_FILE_TOO_LARGE',
          message: 'Unable to read config. Check that the config file is accessible and readable.',
        },
      ];
      for (const { args, method, code, message } of cases) {
        // Stub only this child's fixture access; no permission assumptions or production hooks.
        const script = `
          const fs = require('fs');
          const method = ${JSON.stringify(method)};
          const original = fs[method];
          fs[method] = (file, ...args) => {
            if (file === process.env.BALLIN_TEST_CONFIG_PATH) {
              throw Object.assign(new Error('private path: ' + file), { code: ${JSON.stringify(code)} });
            }
            return original(file, ...args);
          };
          process.argv = [process.execPath, ${JSON.stringify(cliPath)}, 'config', ...${JSON.stringify(args)}];
          require(${JSON.stringify(cliPath)});
        `;
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8', env: testChildEnvironment(),
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `ballin config: ${message}\n`);
        assert.equal(fetchConfigJSON(), before);
      }
    });

    it('rejects object writes and invalid paths with status 1 and no config changes', () => {
      const before = fetchConfigJSON();
      const cases = [
        { args: ['set', 'update', 'false'], message: configMessages.setObjErr('update') },
        ...invalidPathCases.flatMap(([key, missing]) => [
          { args: ['get', key], message: configMessages.getKeysDneErr(missing) },
          { args: ['set', key, 'value'], message: configMessages.setDneErr(missing) },
        ]),
      ];
      for (const { args, message } of cases) {
        const result = runConfigCli(args);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `ballin config: ${message}\n`);
        assert.equal(fetchConfigJSON(), before);
      }
    });

    it('preserves successful output, string values, and the empty-action alias', () => {
      for (const args of [['get'], ['']]) {
        const result = runConfigCli(args);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, `${fetchConfigJSON()}\n`);
        assert.equal(result.stderr, '');
      }
      const object = runConfigCli(['get', 'analytics']);
      assert.equal(object.status, 0);
      assert.equal(object.stdout, "{ enabled: 'true' }\n");
      assert.equal(object.stderr, '');

      for (const value of ['', 'false', 'INVALID: a legitimate stored value']) {
        const set = runConfigCli(['set', 'backup.id', value]);
        assert.equal(set.status, 0);
        assert.equal(set.stdout, `${configMessages.set('backup.id', value)}\n`);
        assert.equal(set.stderr, '');
        const get = runConfigCli(['', 'backup.id']);
        assert.equal(get.status, 0);
        assert.equal(get.stdout, `${value}\n`);
        assert.equal(get.stderr, '');
        assert.strictEqual(getConfig('backup.id'), value);
      }
    });
  });

  describe('configAction', () => {
    it('() should return a String', () => {
      assert.isString(configAction());
    });
    it('("get") should return a String', () => {
      assert.isString(configAction(['get']));
    });
    it('("set") should return a setConfig error', () => {
      assert.throws(() => configAction(['set']), ConfigError, configMessages.setArgsErr);
    });
    it('("get", "backup.id") should return null by default', () => {
      assert.isNull(configAction(['get', 'backup.id']));
    });
    it('("wrong") should return an invalid error', () => {
      assert.throws(() => configAction(['wrong']), ConfigError, configMessages.actionErr);
    });
    it('("set", "backup.id", "123") should set backup.id to "123"', () => {
      setTest('backup.id', '123', setConfigAction);
    });
    it('("reset") should reset config', () => {
      setTest('backup.id', '123', setConfigAction);
      assert.include(configAction(['reset']), 'Config has been reset...\nFROM:');
      assert.isNull(getConfig('backup.id'));
    });
  });

  describe('updateConfig', () => {
    const updateConfigPath = path.join(__dirname, '..', 'config', 'updateConfig.ts');
    const runUpdateConfig = () => spawnSync(process.execPath, [updateConfigPath], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: testChildEnvironment(),
    });

    it('updates the isolated fixture when required directly', () => {
      fs.writeFileSync(configPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, ['-e', "require('./config/updateConfig.ts')"], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: testChildEnvironment(),
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
