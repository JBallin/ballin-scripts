const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const defaultConfig = require('../config/.defaultConfig.json');
const {
  getConfig,
  setConfig,
  configAction,
  configPath,
  fetchConfig,
  configMessages,
} = require('../config');

const fetchConfigJSON = () => fetchConfig().configJSON;

const currentConfigJSON = fetchConfigJSON();

const setTest = (keys, value) => {
  setConfig(keys, value);
  assert.deepEqual(value, getConfig(keys));
};

describe('config', () => {
  let savedConfig;

  it('uses the isolated test config fixture', () => {
    assert.equal(configPath, process.env.BALLIN_TEST_CONFIG_PATH);
    assert.notEqual(configPath, path.join(__dirname, '..', 'ballin.config.json'));
  });

  it('does not treat NODE_ENV=test as a fixture run by itself', () => {
    const result = spawnSync(process.execPath, ['-p', "require('./config').configPath"], {
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
    it('("up.cleanup") should return true or false', () => {
      assert.include(['true', 'false'], getConfig('up.cleanup'));
    });
    it('() should return a String', () => {
      assert.isString(getConfig());
    });
    it('should return an error if given keys that don\'t exist', () => {
      assert.equal(getConfig('wrong'), 'INVALID: "wrong" doesn\'t exist in config');
    });
    it('should report the first missing portion of a nested path', () => {
      assert.equal(getConfig('test.nested'), configMessages.getKeysDneErr('test'));
      assert.equal(getConfig('gu.missing.nested'), configMessages.getKeysDneErr('gu.missing'));
    });
    it('should reject traversal through primitive and null values', () => {
      assert.equal(getConfig('up.cleanup.nested'), configMessages.getKeysDneErr('up.cleanup'));
      assert.equal(getConfig('gu.id.nested'), configMessages.getKeysDneErr('gu.id'));
    });
    it('should not treat inherited properties as config keys', () => {
      assert.equal(getConfig('constructor'), configMessages.getKeysDneErr('constructor'));
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
      assert.equal(setConfig('a', 'b', 'c'), configMessages.setArgsErr);
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
    it('should report the first missing portion without changing config', () => {
      const configBeforeSet = fetchConfigJSON();

      assert.equal(setConfig('test.nested', 'test'), configMessages.setDneErr('test'));
      assert.equal(setConfig('gu.missing.nested', 'test'), configMessages.setDneErr('gu.missing'));
      assert.equal(fetchConfigJSON(), configBeforeSet);
    });
    it('should reject primitive and null traversal without changing config', () => {
      const configBeforeSet = fetchConfigJSON();

      assert.equal(setConfig('up.cleanup.nested', 'test'), configMessages.setDneErr('up.cleanup'));
      assert.equal(setConfig('gu.id.nested', 'test'), configMessages.setDneErr('gu.id'));
      assert.equal(fetchConfigJSON(), configBeforeSet);
    });
    it('should reject inherited paths without changing config', () => {
      const configBeforeSet = fetchConfigJSON();

      assert.equal(setConfig('__proto__.nested', 'test'), configMessages.setDneErr('__proto__'));
      assert.equal(fetchConfigJSON(), configBeforeSet);
    });
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
      setTest('gu.id', '123', configAction);
    });
    it('("reset") should reset config', () => {
      setTest('gu.id', '123', configAction);
      assert.include(configAction('reset'), 'Config has been reset...\nFROM:');
      assert.isNull(getConfig('gu.id'));
    });
  });

  describe('updateConfig', () => {
    it('updates the isolated fixture', () => {
      fs.writeFileSync(configPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, ['-e', "require('./config/updateConfig')"], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: process.env,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(fetchConfig().configObj, defaultConfig);
    });
  });
});
