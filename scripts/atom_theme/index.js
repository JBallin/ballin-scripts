const fs = require('fs');
const CSON = require('cson');
const { getConfig, setConfig } = require('../../config');

const atomConfigPath = `${HOME}/.atom/config.cson`;
const { light, dark } = getConfig('theme');

const fetchAtomConfig = () => CSON.load(atomConfigPath);
const fetchCurrentTheme = () => fetchAtomConfig()['*'].core.themes;

const changeTheme = i => {
  const csonObj = fetchAtomConfig();
  const currentTheme = fetchCurrentTheme();

  theme = {d: 'dark', l: 'light'}[i];

  if (i === undefined) return toggleTheme();
  if (theme === undefined) return 'INVALID: "l" (light), "d" (dark) or "" (toggle)'
  return tryChangeTheme();

  function setTheme(newTheme) {
    csonObj['*'].core.themes = newTheme;
    updatedCsonString = CSON.stringify(csonObj);
    fs.writeFileSync(atomConfigPath, updatedCsonString);
    return `${theme} theme!`;
  }

  function toggleTheme() {
      if (currentTheme[0] === dark[0]) {
        theme = 'light';
        return setTheme(light);
      }
        theme = 'dark';
        return setTheme(dark);
  }

  function tryChangeTheme() {
    let newTheme = determineNewTheme();
    if (currentTheme[0] === newTheme[0]) {
      return `already set to ${theme} theme...`;
    }
    return setTheme(newTheme);
  }

  function determineNewTheme() {
    if (theme === 'dark') {
      return dark;
    } else if (theme === 'light') {
      return light;
    }
  }

}


module.exports = { changeTheme }
