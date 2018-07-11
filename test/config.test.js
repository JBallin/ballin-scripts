const { assert } = require('chai');
const { getConfig, setConfig } = require('../config');

describe('getConfig', () => {
  it("(['theme']) should return an Object", () => {
    assert.typeOf(getConfig(['theme']), 'object')
  })
  it("(['theme', 'dark']) should return an Array", () => {
    assert.typeOf(getConfig(['theme', 'dark']), 'array')
  })
  it("(['gu']) should return an Object", () => {
    assert.typeOf(getConfig(['gu']), 'object')
  })
  it("(['up', 'cleanup']) should return true or false", () => {
    assert.include([true, false], getConfig(['up', 'cleanup']))
  })
});

function setTest(key, val) {
  const current = getConfig(key);

  setConfig(key, val);
  assert.equal(getConfig(key), val)
  setConfig(key, current);
}

describe('setConfig', () => {
  it("should set theme.dark", () => {
    setTest(['theme', 'dark'], ['rainbow', 'rainbow-lite'])
  })
  it("should set up.cleanup", () => {
    setTest(['up', 'cleanup'], 'test');
  })
  it("should set gu.id", () => {
    setTest(['gu', 'id'], '123');
  })
})
