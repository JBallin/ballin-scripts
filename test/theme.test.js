const { assert } = require('chai');
const { changeTheme, saveTheme, themeMessages } = require('../scripts/atom_theme');

describe('theme', () => {
  describe('changeTheme', () => {
    let currTheme = '';
    before('save current theme and initialize theme to dark', () => {
      currTheme = changeTheme('d') === 'already set to dark theme...' ? 'd' : 'l';
    })
    after('set theme back to current theme', () => {
      changeTheme(currTheme);
    })

    it('should not change from dark to dark', () => {
      assert.equal(changeTheme('d'), 'already set to dark theme...');
    })
    it('should change from dark to light', () => {
      assert.equal(changeTheme('l'), 'light theme!');
    })
    it('should change from light to dark', () => {
      assert.equal(changeTheme('d'), 'dark theme!');
    })
    it('should toggle dark to light', () => {
      assert.equal(changeTheme(), 'light theme!');
    })
    it('should toggle light to dark', () => {
      assert.equal(changeTheme(), 'dark theme!');
    })
    it('should be invalid if given wrong input', () => {
      assert.equal(changeTheme('wrong'), 'INVALID: "l" (light), "d" (dark) or "" (toggle)')
    })
  })
  describe('saveTheme', () => {
    // TODO: saveTheme tests here!
  })
})
