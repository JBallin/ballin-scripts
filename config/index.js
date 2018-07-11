const fs = require('fs');
const HOME = require('os').homedir;

const configJSON = fs.readFileSync(`${HOME}/.ballin-scripts/config/config.json`);
const configObj = JSON.parse(configJSON);

const getConfig = keys => {
  return keys.reduce((res, key) => {
    return res[key]
  }, configObj)
}

module.exports = getConfig;
