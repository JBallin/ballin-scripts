const fs = require('fs');
const HOME = require('os').homedir;
const { exec } = require('child_process')

const configPath = `${HOME}/.ballin-scripts/config/config.json`
const stringify = obj => JSON.stringify(obj, null, 2);

const fetchConfig = () => {
  const configJSON = fs.readFileSync(configPath, 'utf8');
  const configObj = JSON.parse(configJSON);
  return { configObj, configJSON }
}

const getConfig = keys => {
  const { configObj, configJSON } = fetchConfig();
  if (keys !== undefined) {
    res = keys.split('.').reduce((res, key) => res[key], configObj)
    return res !== undefined ? res : `${keys} doesn't exist in config`
  } else {
    return configJSON;
  }
}

const setConfig = (keys, val, ...other) => {
  const { configObj } = fetchConfig();
  if (other.length || keys === undefined || val === undefined) {
    return 'INVALID: setConfig takes two arguments, keys and value'
  }
  keysArr = keys.split('.');
  set = keysArr.splice(-1);
  nestedObj = keysArr.reduce((res, key) => res[key], configObj);
  if (typeof nestedObj[set] === 'object') {
    return `INVALID: "${keys}" is an object`
  } else if (nestedObj[set] === undefined) {
    return `INVALID: "${keys}" doesn't exist in config`
  }
  fs.writeFileSync(configPath, stringify(configObj), 'utf8')
  return `"${keys}" set to ${getConfig(keys)}`;
}

const configAction = (request, keys, value, other='') => {
  if (request === 'get' || request === undefined) {
    return getConfig(keys);
  } else if (request === 'set') {
    return setConfig(keys, value);
  } else {
    if (process.env.NODE_ENV !== 'test') {
      exec('ballin', (error, stdout, stderr) => console.log(stdout));
    }
    return "INVALID"
  }
}

module.exports = { getConfig, setConfig, configAction, stringify, configPath, fetchConfig };
