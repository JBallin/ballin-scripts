const fs = require('fs');
const { exec } = require('child_process')
const HOME = require('os').homedir;

const configPath = `${HOME}/.ballin-scripts/config/ballin.json`
const defaultConfigPath = `${HOME}/.ballin-scripts/config/.defaultconfig.json`
const stringify = obj => JSON.stringify(obj, null, 2);

const configMessages = {
  actionErr: "INVALID!",
  getKeysDneErr: keys => `"${keys}" doesn't exist in config`,
  reset: "Config has been reset to default configuration",
  set: keys => `"${keys}" set to: ${JSON.stringify(getConfig(keys))}`,
  setArgsErr: 'INVALID: setConfig takes two arguments: "keys" and "value"',
  setDneErr: keys => `INVALID: "${keys}" doesn't exist in config`,
  setObjErr: (keys, prevVal) => `INVALID: "${keys} is not a bottom-level value, it returns ${JSON.stringify(prevVal)}."`
}

const resetConfig = () => {
  const defaultConfig = fs.readFileSync(defaultConfigPath, 'utf8');
  fs.writeFileSync(configPath, defaultConfig, 'utf8')
}

const fetchConfig = () => {
  const configJSON = fs.readFileSync(configPath, 'utf8');
  const configObj = JSON.parse(configJSON);
  return { configObj, configJSON }
}

const getConfig = keys => {
  const { configObj, configJSON } = fetchConfig();
  if (keys !== undefined) {
    res = keys.split('.').reduce((res, key) => res[key], configObj)
    return res !== undefined ? res : configMessages.getKeysDneErr(keys);
  } else {
    return configJSON;
  }
}

const setConfig = (keys, val, ...other) => {
  const { configObj } = fetchConfig();
  if (other.length || keys === undefined || val === undefined) {
    return configMessages.setArgsErr;
  }
  keysArr = keys.split('.');
  set = keysArr.splice(-1);
  nestedObj = keysArr.reduce((res, key) => res[key], configObj);
  const oldVal = nestedObj[set];
  if (typeof oldVal === 'object' && ! Array.isArray(oldVal)) {
    return configMessages.setObjErr(keys);
  } else if (oldVal === undefined) {
    return configMessages.setDneErr(keys);
  } else {
    nestedObj[set] = val;
    fs.writeFileSync(configPath, stringify(configObj), 'utf8')
    return configMessages.set(keys);
  }
}

const configAction = (request, keys, value, other='') => {
  if (request === 'reset') {
    resetConfig();
    return configMessages.reset;
  }
  if (request === 'get' || request === undefined) {
    return getConfig(keys);
  } else if (request === 'set') {
    return setConfig(keys, value);
  } else {
    if (process.env.NODE_ENV !== 'test') {
      exec('ballin', (error, stdout, stderr) => console.log(stdout));
    }
    return configMessages.actionErr;
  }
}

module.exports = { getConfig, setConfig, configAction, stringify, configPath, fetchConfig, configMessages };
