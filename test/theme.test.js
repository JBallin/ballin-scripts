const { assert } = require('chai');
const theme = require('../scripts/atom_theme/index.js');

describe('theme: initialized to dark', () => {
  theme('d')

  it('should not change from dark to dark', () => {
    assert.equal(theme('d'), 'already set to dark theme...');
  })
  it('should change from dark to light', () => {
    assert.equal(theme('l'), 'light theme!');
  })
  it('should change from light to dark', () => {
    assert.equal(theme('d'), 'dark theme!');
  })
  it('should toggle dark to light', () => {
    assert.equal(theme(), 'light theme!');
  })
  it('should toggle light to dark', () => {
    assert.equal(theme(), 'dark theme!');
  })
  it('should be invalid if given wrong input', () => {
    assert.equal(theme('wrong'), 'INVALID: "l" (light), "d" (dark) or "" (toggle)')
  })
})
