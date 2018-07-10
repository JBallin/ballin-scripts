const fs = require('fs');
const CSON = require('cson');
const HOME = require('os').homedir();
const {lightTheme, darkTheme} = require(`${HOME}/.ballin-scripts/config.js`);
const atomConfig = `${HOME}/.atom/config.cson`

module.exports = theme => {
  theme = {d: 'dark', l: 'light'}[theme];
  const csonObj = CSON.load(atomConfig);
  const currentTheme = csonObj['*'].core.themes

  if (theme === undefined) {
    toggleTheme();
  } else {
    tryChangeTheme();
  }

  function setTheme(newTheme) {
    csonObj['*'].core.themes = newTheme;
    updatedCsonString = CSON.stringify(csonObj);
    fs.writeFileSync(atomConfig, updatedCsonString);
  }

  function toggleTheme() {
    if (currentTheme[0] === darkTheme[0]) {
      setTheme(lightTheme);
      console.log('light theme!');
    } else {
      setTheme(darkTheme)
      console.log('dark theme!');
    }
  }

  function tryChangeTheme() {
    let newTheme = determineNewTheme();
    if (newTheme === undefined) {
      console.log('INVALID: input "l" (light) or "d" (dark) or nothing (toggle)');
    } else if (currentTheme[0] === newTheme[0]) {
      console.log(`already set to ${theme} theme...`)
    } else {
      setTheme(newTheme);
      console.log(`changed to ${theme} theme!`)
      }
    }

  function determineNewTheme() {
    if (theme === 'dark') {
      return darkTheme;
    } else if (theme === 'light') {
      return lightTheme;
    }
  }

}