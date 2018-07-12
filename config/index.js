const fs = require('fs');
const HOME = require('os').homedir;

const configJSON = fs.readFileSync(`${HOME}/.ballin-scripts/config/config.json`);
const configObj = JSON.parse(configJSON);

const getConfig = keys =>
  keys ? keys.split('.').reduce((res, key) => res[key], configObj) : configObj

const setConfig = (keys, val, ...other) => {
  if (other.length || keys === undefined || val === undefined) {
    return 'INVALID: setConfig takes two arguments, keys and value'
  }
  keysArr = keys.split('.');
  set = keysArr.splice(-1);
  nestedObj = keysArr.reduce((res, key) => res[key], configObj);
  nestedObj[set] = val;
}

module.exports = { getConfig, setConfig };

console.log(setConfig());
