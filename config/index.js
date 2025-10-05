const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const configPath = path.join(__dirname, '..', 'ballin.config.json');
const defaultConfigPath = path.join(__dirname, '.defaultConfig.json');
const stringify = (obj) => JSON.stringify(obj, null, 2);

const configMessages = {
  actionErr: 'INVALID: ballin_config accepts "", "get", "set", or "reset"',
  getKeysDneErr: (keys) => `INVALID: "${keys}" doesn't exist in config`,
  reset: (prevConfig, defaultConfig) => `Config has been reset FROM:\n${prevConfig}\nTO:\n${defaultConfig}`,
  set: (keys) => `"${keys}" set to: ${JSON.stringify(getConfig(keys))}`, // eslint-disable-line no-use-before-define
  setArgsErr: 'INVALID: setConfig takes two arguments: "key(s)" and "value"',
  getArgsErr: 'INVALID: getConfig takes one argument: "key(s)"',
  setDneErr: (keys) => `INVALID: "${keys}" doesn't exist in config`,
  setObjErr: (keys, prevVal) => `INVALID: "${keys}" is not a bottom-level value, it returns ${JSON.stringify(prevVal)}.`,
};

const fetchConfig = () => {
  const configJSON = fs.readFileSync(configPath, 'utf8');
  const configObj = JSON.parse(configJSON);
  return { configObj, configJSON };
};

// TODO: guard against deep missing paths in getConfig/setConfig
//       (e.g., "gu.foo.bar" → return DNE instead of throw)
const getConfig = (keys, val) => {
  if (val) return configMessages.getArgsErr;
  const { configObj, configJSON } = fetchConfig();
  if (keys !== undefined) {
    const res = keys.split('.').reduce((result, key) => result[key], configObj);
    return res !== undefined ? res : configMessages.getKeysDneErr(keys);
  }
  return configJSON;
};

const resetConfig = () => {
  const prevConfig = getConfig();
  const defaultConfig = fs.readFileSync(defaultConfigPath, 'utf8');
  fs.writeFileSync(configPath, defaultConfig, 'utf8');
  return configMessages.reset(prevConfig, defaultConfig);
};

const setConfig = (keys, val, other) => {
  const { configObj } = fetchConfig();
  if ((other && other.length) || !keys || val === undefined) {
    return configMessages.setArgsErr;
  }
  const keysArr = keys.split('.');
  // ex: 'up.cleanup' -> [ 'up', 'cleanup' ]
  const keyToSet = keysArr.pop();
  // 'true'
  const topLevelKeys = keysArr;
  // [ 'up' ]
  const nestedObj = topLevelKeys.reduce((res, key) => res[key], configObj);
  // { cleanup: 'false', ballin: 'true' }
  const prevVal = nestedObj[keyToSet];
  // 'false'

  // make sure prevVal isn't an object (gu.id defaults to null)
  if (typeof prevVal === 'object' && prevVal !== null) {
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
  if (request === 'reset') return resetConfig();
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
