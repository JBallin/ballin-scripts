const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const userConfigPath = path.join(__dirname, '..', 'ballin.config.json');
const configPath = process.env.BALLIN_TEST_CONFIG_PATH || userConfigPath;
const defaultConfigPath = path.join(__dirname, '.defaultConfig.json');
const stringify = (obj) => JSON.stringify(obj, null, 2);
// Only JSON-owned keys count; inherited properties are not config entries.
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

// Return the value, or the first path prefix that cannot be resolved.
const getNestedValue = (configObj, keys) => {
  const keysArr = keys.split('.');
  let value = configObj;

  for (let index = 0; index < keysArr.length; index += 1) {
    const key = keysArr[index];
    const resolvedKeys = keysArr.slice(0, index + 1).join('.');
    if (value === null || typeof value !== 'object' || !hasOwn(value, key)) {
      return { missingKeys: resolvedKeys };
    }
    value = value[key];
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
  const keyToSet = keysArr.pop();
  const parentKeys = keysArr;
  // Resolve the parent first: setConfig updates existing leaves and never creates paths.
  const { value: nestedObj, missingKeys } = parentKeys.length
    ? getNestedValue(configObj, parentKeys.join('.'))
    : { value: configObj };
  if (missingKeys !== undefined) {
    return configMessages.setDneErr(missingKeys);
  }
  if (nestedObj === null || typeof nestedObj !== 'object') {
    return configMessages.setDneErr(keys);
  }
  if (!hasOwn(nestedObj, keyToSet)) {
    return configMessages.setDneErr(keys);
  }
  const prevVal = nestedObj[keyToSet];

  // Objects are containers, but null is a valid leaf value (for example, gu.id).
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
