const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const userConfigPath = path.join(__dirname, '..', 'ballin.config.json');
const configPath = process.env.BALLIN_TEST_CONFIG_PATH || userConfigPath;
const defaultConfigPath = path.join(__dirname, '.defaultConfig.json');
const stringify = (obj) => JSON.stringify(obj, null, 2);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const configMessages = {
  actionErr: 'INVALID: ballin_config accepts "", "get", "set", or "reset"',
  getKeysDneErr: (keys) => `INVALID: "${keys}" doesn't exist in config`,
  reset: (prevConfig, defaultConfig) => `Config has been reset...\nFROM:\n${prevConfig}TO:\n${defaultConfig}`,
  set: (keys, newConfig) => `"${keys}" set to: ${JSON.stringify(newConfig)}`,
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

const getNestedValue = (configObj, keys) => {
  const keysArr = keys.split('.');
  let value = configObj;

  for (let index = 0; index < keysArr.length; index += 1) {
    if (value === null || typeof value !== 'object') {
      return { missingKeys: keysArr.slice(0, index + 1).join('.') };
    }
    if (!hasOwn(value, keysArr[index])) {
      return { missingKeys: keysArr.slice(0, index + 1).join('.') };
    }
    value = value[keysArr[index]];
  }

  return { value };
};

const getConfig = (keys, val) => {
  if (val) return configMessages.getArgsErr;
  const { configObj, configJSON } = fetchConfig();
  if (keys !== undefined) {
    const { value, missingKeys } = getNestedValue(configObj, keys);
    return missingKeys === undefined ? value : configMessages.getKeysDneErr(missingKeys);
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
  const { value: nestedObj, missingKeys } = topLevelKeys.length
    ? getNestedValue(configObj, topLevelKeys.join('.'))
    : { value: configObj };
  if (missingKeys !== undefined) {
    return configMessages.setDneErr(missingKeys);
  }
  if (nestedObj === null || typeof nestedObj !== 'object') {
    return configMessages.setDneErr(keys);
  }
  // { cleanup: 'false', ballin: 'true' }
  if (!hasOwn(nestedObj, keyToSet)) {
    return configMessages.setDneErr(keys);
  }
  const prevVal = nestedObj[keyToSet];
  // 'false'

  // make sure prevVal isn't an object (gu.id defaults to null)
  if (typeof prevVal === 'object' && prevVal !== null) {
    return configMessages.setObjErr(keys, prevVal);
  }
  nestedObj[keyToSet] = val;
  fs.writeFileSync(configPath, stringify(configObj), 'utf8');
  return configMessages.set(keys, getConfig(keys));
};

const configAction = (request, keys, value, other) => {
  if (request === 'reset') return resetConfig();
  // send config auto if not given a request with ballin_config command
  if (request === 'get' || !request) return getConfig(keys, value);
  if (request === 'set') return setConfig(keys, value, other);
  if (process.env.NODE_ENV !== 'test') {
    // exec() is async, so actionErr is returned before the help output is printed.
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
