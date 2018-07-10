const fs = require('fs');
const CSON = require('cson');
const HOME = require('os').homedir();
const config = fs.readFileSync(`${HOME}/.ballin-scripts/config/config.json`)
const {lightTheme, darkTheme} = JSON.parse(config).theme;
const atomConfig = `${HOME}/.atom/config.cson`

module.exports = i => {
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
      if (currentTheme[0] === darkTheme[0]) {
        theme = 'light';
        return setTheme(lightTheme);
      }
        theme = 'dark';
        return setTheme(darkTheme);
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
      return darkTheme;
    } else if (theme === 'light') {
      return lightTheme;
    }
  }

}
