const fs = require('fs');
const CSON = require('cson');
const HOME = require('os').homedir;
const { getConfig, setConfig } = require('../../config');

const atomConfigPath = `${HOME}/.atom/config.cson`;
const { light, dark } = getConfig('theme');
const fetchAtomConfig = () => CSON.load(atomConfigPath);
const fetchCurrentTheme = () => fetchAtomConfig()['*'].core.themes;
const themeMessages = {
  saveErr: 'INVALID: saveTheme takes \'d\' (dark) or \'l\' (light)',
  currErr: 'ERROR: your atom config does not have a theme, please try changing your theme to Atom Light and try again',
  argErr: 'INVALID: "l" (light), "d" (dark) or "" (toggle)',
};

const determineMode = (mode) => {
  switch (mode) {
    case 'd':
      return 'dark';
    case 'l':
      return 'light';
    default:
      return 'error';
  }
};

const saveTheme = (mode) => {
  const currentTheme = fetchCurrentTheme();
  const newMode = determineMode(mode);
  if (newMode === 'error') return themeMessages.saveErr;
  return setConfig(`theme.${newMode}`, currentTheme);
};

const changeTheme = (mode) => {
  const csonObj = fetchAtomConfig();
  const currentTheme = fetchCurrentTheme();
  if (!currentTheme) return themeMessages.currErr;
  let theme = determineMode(mode);

  const setTheme = (newTheme) => {
    csonObj['*'].core.themes = newTheme;
    fs.writeFileSync(atomConfigPath, CSON.stringify(csonObj));
    return `${theme} theme!`;
  };

  const toggleTheme = () => {
    if (currentTheme[0] === dark[0]) {
      theme = 'light';
      return setTheme(light);
    }
    theme = 'dark';
    return setTheme(dark);
  };

  const determineNewTheme = oldTheme => ({ light, dark })[oldTheme];

  const tryChangeTheme = () => {
    const newTheme = determineNewTheme(theme);
    if (!newTheme) return themeMessages.argErr;
    if (currentTheme[0] === newTheme[0]) return `already set to ${theme} theme...`;
    return setTheme(newTheme);
  };

  if (!mode) return toggleTheme();
  return tryChangeTheme();
};


module.exports = { changeTheme, saveTheme, themeMessages };
