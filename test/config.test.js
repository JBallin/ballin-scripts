const { assert } = require('chai');
const { getConfig, setConfig } = require('../config');

describe('getConfig', () => {
  it("('theme') should return an Object", () => {
    assert.typeOf(getConfig('theme'), 'object')
  })
  it("('theme.dark') should return an Array", () => {
    assert.typeOf(getConfig('theme.dark'), 'array')
  })
  it("('gu') should return an Object", () => {
    assert.typeOf(getConfig('gu'), 'object')
  })
  it("('up.cleanup') should return true or false", () => {
    assert.include([true, false], getConfig('up.cleanup'))
  })
  it("() should return an Object", () => {
    assert.typeOf(getConfig(), 'object')
  })
  it("should return an error if given keys that don't exist", () => {
    assert.equal(getConfig('wrong'), "wrong doesn't exist in config")
  })
});

describe('setConfig', () => {
  const initialConfig = getConfig();
  function setTest(keys, val) {
    const current = getConfig(keys);

    setConfig(keys, val);
    assert.equal(getConfig(keys), val)
    setConfig(keys, current);
  }
  
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
    assert.equal(setConfig(), 'INVALID: setConfig takes two arguments, keys and value')
  })
  it("should give error if given 3 arguments", () => {
    assert.equal(setConfig('a','b','c'), 'INVALID: setConfig takes two arguments, keys and value')
  })
  it("should return the keys/value it set", () => {
    const keys = 'theme.light';
    const val = 'new theme';
    const current = getConfig(keys);
    assert.equal(setConfig(keys, val), `"${keys}" set to "${val}"`)
    setConfig(keys, current);
  })
  it("should not have changed config prior to tests", () => {
    assert.equal(getConfig(), initialConfig)
  })
})
