const fs = require('fs');
const HOME = require('os').homedir;

const configJSON = fs.readFileSync(`${HOME}/.ballin-scripts/config/config.json`);
const configObj = JSON.parse(configJSON);

const getConfig = keys => {
  if (keys !== undefined) {
    res = keys.split('.').reduce((res, key) => res[key], configObj)
    return res !== undefined ? res : `${keys} doesn't exist in config`
  } else {
    return configObj;
  }
}

const setConfig = (keys, val, ...other) => {
  if (other.length || keys === undefined || val === undefined) {
    return 'INVALID: setConfig takes two arguments, keys and value'
  }
  keysArr = keys.split('.');
  set = keysArr.splice(-1);
  nestedObj = keysArr.reduce((res, key) => res[key], configObj);
  nestedObj[set] = val;
  return `"${keys}" set to "${getConfig(keys)}"`;
}

module.exports = { getConfig, setConfig };
