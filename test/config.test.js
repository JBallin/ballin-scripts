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
