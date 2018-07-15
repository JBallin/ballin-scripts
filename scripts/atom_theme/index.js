const fs = require('fs');
const CSON = require('cson');
const HOME = require('os').homedir();

const configPath = `${HOME}/.ballin-scripts/config/config.json`;
const configJSON = fs.readFileSync(configPath);
const { light, dark } = JSON.parse(configJSON).theme;
const atomConfig = `${HOME}/.atom/config.cson`;

const changeTheme = i => {
  const csonObj = CSON.load(atomConfig);
  const currentTheme = csonObj['*'].core.themes;
  theme = {d: 'dark', l: 'light'}[i];

  if (i === undefined) return toggleTheme();
  if (theme === undefined) return 'INVALID: "l" (light), "d" (dark) or "" (toggle)'
  return tryChangeTheme();

  function setTheme(newTheme) {
    csonObj['*'].core.themes = newTheme;
    updatedCsonString = CSON.stringify(csonObj);
    fs.writeFileSync(atomConfig, updatedCsonString);
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
