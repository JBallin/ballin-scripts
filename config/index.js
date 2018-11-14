const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const configPath = path.join(__dirname, './ballin.json');
const defaultConfigPath = path.join(__dirname, './.defaultconfig.json');
const stringify = obj => JSON.stringify(obj, null, 2);

const configMessages = {
  actionErr: 'INVALID: ballin_config accepts "", "get", or "set"',
  getKeysDneErr: keys => `"${keys}" doesn't exist in config`,
  reset: 'Config has been reset to default configuration',
  set: keys => `"${keys}" set to: ${JSON.stringify(getConfig(keys))}`, // eslint-disable-line
  setArgsErr: 'INVALID: setConfig takes two arguments: "key(s)" and "value"',
  getArgsErr: 'INVALID: getConfig takes two arguments: "key(s)" and "value"',
  setDneErr: keys => `INVALID: "${keys}" doesn't exist in config`,
  setObjErr: (keys, prevVal) => `INVALID: "${keys} is not a bottom-level value, it returns ${JSON.stringify(prevVal)}."`,
};

const resetConfig = () => {
  const defaultConfig = fs.readFileSync(defaultConfigPath, 'utf8');
  fs.writeFileSync(configPath, defaultConfig, 'utf8');
};

const fetchConfig = () => {
  const configJSON = fs.readFileSync(configPath, 'utf8');
  const configObj = JSON.parse(configJSON);
  return { configObj, configJSON };
};

const getConfig = (keys, val) => {
  if (val) return configMessages.getArgsErr;
  const { configObj, configJSON } = fetchConfig();
  if (keys !== undefined) {
    const res = keys.split('.').reduce((result, key) => result[key], configObj);
    return res !== undefined ? res : configMessages.getKeysDneErr(keys);
  } return configJSON;
};

const setConfig = (keys, val, other) => {
  const { configObj } = fetchConfig();
  if ((other && other.length) || !keys || val === undefined) {
    return configMessages.setArgsErr;
  }
  const keysArr = keys.split('.');
  // ex: 'theme.light' -> [ 'theme', 'light' ]
  const keyToSet = keysArr.splice(-1);
  // 'light'
  const topLevelKeys = keysArr;
  // [ 'theme' ]
  const nestedObj = topLevelKeys.reduce((res, key) => res[key], configObj);
  // { light: 'lightTheme', dark: 'darkTheme' }
  const prevVal = nestedObj[keyToSet];
  // 'lightTheme'

  // make sure prevVal isn't an object (arrays and null are ok: gu.id defaults to null)
  if (typeof prevVal === 'object' && !Array.isArray(prevVal) && prevVal !== null) {
    return configMessages.setObjErr(keys, prevVal);
  }
  if (prevVal === undefined) {
    return configMessages.setDneErr(keys);
  }
  nestedObj[keyToSet] = val;
  fs.writeFileSync(configPath, stringify(configObj), 'utf8');
  return configMessages.set(keys);
};

const configAction = (request, keys, value, other) => {
  if (request === 'reset') {
    resetConfig();
    return configMessages.reset;
  }
  // send config auto if not given a request with ballin_config command
  if (request === 'get' || !request) return getConfig(keys, value);
  if (request === 'set') return setConfig(keys, value, other);
  if (process.env.NODE_ENV !== 'test') {
    exec('ballin', (error, stdout) => console.log(stdout)); // eslint-disable-line no-console
  }
  return configMessages.actionErr;
};

module.exports = {
  getConfig,
  setConfig,
  configAction,
  stringify,
  configPath,
  fetchConfig,
  configMessages,
};
