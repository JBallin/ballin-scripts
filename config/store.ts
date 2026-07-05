const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

type ConfigLeaf = string | number | boolean | null;
type ConfigObject = { [key: string]: ConfigValue };
type ConfigValue = ConfigLeaf | ConfigObject;
type NestedValueResult = {
  value?: ConfigValue;
  missingKeys?: string;
};
type ResetPreviousConfigResult = {
  display: string;
};
type ConfigStoreOptions = {
  configPath: string;
  defaultConfigPath?: string;
};

const stringify = (obj: ConfigObject) => JSON.stringify(obj, null, 2);

// Only JSON-owned keys count; inherited properties are not config entries.
const hasOwn = (obj: ConfigObject, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

const configMessages = {
  actionErr: 'INVALID: ballin config accepts "", "get", "set", or "reset"',
  getKeysDneErr: (keys: string) => `INVALID: "${keys}" doesn't exist in config`,
  reset: (prevConfig: ConfigValue, defaultConfig: string) => (
    `Config has been reset...\nFROM:\n${prevConfig}TO:\n${defaultConfig}`
  ),
  set: (keys: string, newConfig: ConfigValue) => `"${keys}" set to: ${JSON.stringify(newConfig)}`,
  setArgsErr: 'INVALID: setConfig takes two arguments: "key(s)" and "value"',
  getArgsErr: 'INVALID: getConfig takes one argument: "key(s)"',
  setDneErr: (keys: string) => `INVALID: "${keys}" doesn't exist in config`,
  setObjErr: (keys: string, prevVal: ConfigValue) => (
    `INVALID: "${keys}" is not a bottom-level value, it returns ${JSON.stringify(prevVal)}.`
  ),
};

// Return the value, or the first path prefix that cannot be resolved.
const getNestedValue = (configObj: ConfigObject, keys: string): NestedValueResult => {
  const keysArr = keys.split('.');
  let value: ConfigValue = configObj;

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

const createConfigStore = ({
  configPath,
  defaultConfigPath = path.join(__dirname, '.defaultConfig.json'),
}: ConfigStoreOptions) => {
  const fetchConfig = () => {
    const configJSON = fs.readFileSync(configPath, 'utf8');
    const configObj = JSON.parse(configJSON) as ConfigObject;
    return { configObj, configJSON };
  };

  const readPreviousConfigForReset = (): ResetPreviousConfigResult => {
    try {
      return { display: fs.readFileSync(configPath, 'utf8') };
    } catch {
      return { display: `Unable to read ${configPath}.\n` };
    }
  };

  const getConfig = (keys?: string, val?: string): ConfigValue | string => {
    if (val) return configMessages.getArgsErr;
    const { configObj, configJSON } = fetchConfig();
    if (keys !== undefined) {
      const { value, missingKeys } = getNestedValue(configObj, keys);
      return missingKeys === undefined
        ? value as ConfigValue
        : configMessages.getKeysDneErr(missingKeys);
    }
    return configJSON;
  };

  const resetConfig = () => {
    const { display: prevConfig } = readPreviousConfigForReset();
    const defaultConfig = fs.readFileSync(defaultConfigPath, 'utf8');
    fs.writeFileSync(configPath, defaultConfig, 'utf8');
    return configMessages.reset(prevConfig, defaultConfig);
  };

  const setConfig = (keys?: string, val?: ConfigValue, other?: string[]) => {
    const { configObj } = fetchConfig();
    if ((other && other.length) || !keys || val === undefined) {
      return configMessages.setArgsErr;
    }
    const keysArr = keys.split('.');
    const keyToSet = keysArr.pop() as string;
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

    // Objects are containers, but null is a valid leaf value (for example, backup.id).
    if (typeof prevVal === 'object' && prevVal !== null) {
      return configMessages.setObjErr(keys, prevVal);
    }
    nestedObj[keyToSet] = val;
    fs.writeFileSync(configPath, stringify(configObj), 'utf8');
    return configMessages.set(keys, getConfig(keys));
  };

  const readLeafValue = (keys: string): ConfigLeaf | undefined => {
    try {
      const { configObj } = fetchConfig();
      const { value, missingKeys } = getNestedValue(configObj, keys);
      if (missingKeys !== undefined || (typeof value === 'object' && value !== null)) {
        return undefined;
      }
      return value as ConfigLeaf;
    } catch {
      return undefined;
    }
  };

  const writeLeafValue = (keys: string, value: ConfigLeaf): boolean => {
    try {
      const result = setConfig(keys, value);
      return result === configMessages.set(keys, value);
    } catch {
      return false;
    }
  };

  const configAction = (request?: string, keys?: string, value?: string, other?: string[]) => {
    if (request === 'reset') return resetConfig();
    // Send full config when no explicit request is provided.
    if (request === 'get' || !request) return getConfig(keys, value);
    if (request === 'set') return setConfig(keys, value, other);
    if (process.env.NODE_ENV !== 'test') {
      // exec() is async, so actionErr is returned before the help output is printed.
      exec('ballin', (error: Error | null, stdout: string) => console.log(stdout)); // eslint-disable-line no-console
    }
    return configMessages.actionErr;
  };

  return {
    configAction,
    configPath,
    fetchConfig,
    getConfig,
    readLeafValue,
    resetConfig,
    setConfig,
    writeLeafValue,
  };
};

module.exports = {
  configMessages,
  createConfigStore,
  stringify,
};
