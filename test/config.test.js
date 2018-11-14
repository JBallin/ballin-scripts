const { assert } = require('chai');
const fs = require('fs');
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
    it('("theme") should return an Object', () => {
      assert.isObject(getConfig('theme'));
    });
    it('("theme.dark") should return an Array', () => {
      assert.isArray(getConfig('theme.dark'));
    });
    it('("gu.id") should return a String', () => {
      assert.isString(getConfig('gu.id'));
    });
    it('("up.cleanup") should return true or false', () => {
      assert.include(['true', 'false'], getConfig('up.cleanup'));
    });
    it('() should return a String', () => {
      assert.isString(getConfig());
    });
    it('should return an error if given keys that don\'t exist', () => {
      assert.equal(getConfig('wrong'), '"wrong" doesn\'t exist in config');
    });
  });


  describe('setConfig', () => {
    const initialConfig = fetchConfigJSON();

    after('setConfig tests shouldn\'t alter config', () => {
      assert.equal(fetchConfigJSON(), initialConfig);
    });

    it('should set theme.dark', () => {
      setTest('theme.dark', ['rainbow', 'rainbow-lite']);
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
      const keys = 'theme.light';
      const val = 'new theme';
      assert.equal(setConfig(keys, val), `"${keys}" set to: "${val}"`);
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
    it('("get", "gu.id") should return a Number', () => {
      assert.isString(configAction('get', 'gu.id'));
    });
    it('("get", "theme.light") should return an Array', () => {
      assert.isArray(configAction('get', 'theme.light'));
    });
    it('("wrong") should return an invalid error', () => {
      assert.equal(configAction('wrong'), configMessages.actionErr);
    });
    it('("set", "gu.id", "123") should set gu.id to "123"', () => {
      setTest('gu.id', '123', configAction);
    });
  });
});
