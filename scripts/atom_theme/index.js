const fs = require('fs');
const CSON = require('cson');
const HOME = require('os').homedir;
const { getConfig, setConfig } = require(`${HOME}/.ballin-scripts/config`);

const atomConfigPath = `${HOME}/.atom/config.cson`;
const { light, dark } = getConfig('theme');

const fetchAtomConfig = () => CSON.load(atomConfigPath);
const fetchCurrentTheme = () => fetchAtomConfig()['*'].core.themes;

const themeMessages = {
  saveErr: "INVALID: saveTheme takes 'd' (dark) or 'l' (light)"
}


const saveTheme = mode => {
  const currentTheme = fetchCurrentTheme();
  const newMode = mode === 'd' ? 'dark' : mode === 'l' ? 'light' : undefined;
  if (newMode) {
    return setConfig(`theme.${newMode}`, currentTheme);
  } else {
    return themeMessages.saveErr;
  }
}


const changeTheme = mode => {
  const csonObj = fetchAtomConfig();
  const currentTheme = fetchCurrentTheme();

  theme = {d: 'dark', l: 'light'}[mode];

  if (mode === undefined) return toggleTheme();
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


module.exports = { changeTheme, saveTheme, themeMessages }
