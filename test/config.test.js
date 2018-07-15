process.env.NODE_ENV = 'test'

const { assert } = require('chai');
const { getConfig, setConfig, configAction, stringify, configPath, fetchConfig } = require('../config');
const fs = require('fs');

const fetchConfigJSON = () => fetchConfig().configJSON;

const setConfigErr = 'INVALID: setConfig takes two arguments, keys and value';
const invalidErr = 'INVALID';
const currentConfigJSON = fetchConfigJSON();

const setTest = (keys, value) => {
  setConfig(keys, value);
  assert.equal(stringify(value), getConfig(keys, value))
}


describe('config', () => {

  before("fetchConfigJSON should return a String", () => {
    assert.typeOf(fetchConfigJSON(), 'String');
  })
  after("tests shouldn't alter config", () => {
    assert.equal(currentConfigJSON, fetchConfigJSON());
  })
  beforeEach('Save config', () => {
    savedConfig = fetchConfigJSON();
    assert.typeOf(savedConfig, 'String');
  })
  afterEach('Reset config', () => {
    fs.writeFileSync(configPath, savedConfig, 'utf8');
  })

  describe('getConfig', () => {
    it("('theme') should return a String", () => {
      assert.typeOf(getConfig('theme'), 'string')
    })
    it("('theme.dark') should return a String", () => {
      assert.typeOf(getConfig('theme.dark'), 'string')
    })
    it("('gu') should return a String", () => {
      assert.typeOf(getConfig('gu'), 'string')
    })
    it("('up.cleanup') should return 'true' or 'false'", () => {
      assert.include(['true', 'false'], getConfig('up.cleanup'))
    })
    it("() should return a String", () => {
      assert.typeOf(getConfig(), 'string')
    })
    it("should return an error if given keys that don't exist", () => {
      assert.equal(getConfig('wrong'), "wrong doesn't exist in config")
    })
  });


  describe('setConfig', () => {
    let savedConfig = '';
    const initialConfig = fetchConfigJSON();

    after("setConfig tests shouldn't alter config", () => {
      assert.equal(fetchConfigJSON(), initialConfig)
    })


    it("should set theme.dark", () => {
      setTest('theme.dark', ['rainbow', 'rainbow-lite'])
    })
    it("should set up.cleanup", () => {
      setTest('up.cleanup', 'test');
    })
    it("should set gu.id", () => {
      setTest('gu.id', '123');
    })
    it("should give error if given no arguments", () => {
      assert.equal(setConfig(), setConfigErr)
    })
    it("should give error if given 3 arguments", () => {
      assert.equal(setConfig('a','b','c'), setConfigErr)
    })
    it("should return the keys/value it set", () => {
      const keys = 'theme.light';
      const val = 'new theme';
      assert.equal(setConfig(keys, val), `"${keys}" set to "${val}"`)
    })
  })

  describe('configAction', () => {
    it("() should return a String", () => {
      assert.typeOf(configAction('get'), 'string');
    })
    it("('get') should return a String", () => {
      assert.typeOf(configAction('get'), 'string');
    })
    it("('set') should return a setConfig error", () => {
      assert.equal(configAction('set'), setConfigErr)
    })
    it("('get', 'gu.id') should return a Number", () => {
      assert.typeOf(configAction('get', 'gu.id'), 'string')
    })
    it("('get', 'theme.light') should return a string", () => {
      assert.typeOf(configAction('get', 'theme.light'), 'string')
    })
    it("('wrong') should return an invalid error", () => {
      assert.equal(configAction('wrong'), invalidErr);
    })
    it("('set', 'gu.id', '123') should set gu.id to '123'", () => {
      setTest('gu.id', '123', configAction);
    })
  })

})
