const fs = require('fs');
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

class ConfigError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const stringify = (obj: ConfigObject) => JSON.stringify(obj, null, 2);

// Only JSON-owned keys count; inherited properties are not config entries.
const hasOwn = (obj: ConfigObject, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

const configMessages = {
  actionErr: 'Unknown config action.',
  getKeysDneErr: (keys: string) => `"${keys}" doesn't exist in config. Use ballin config get to inspect available keys.`,
  reset: (prevConfig: ConfigValue, defaultConfig: string) => (
    `Config has been reset...\nFROM:\n${prevConfig}TO:\n${defaultConfig}`
  ),
  set: (keys: string, newConfig: ConfigValue) => `"${keys}" set to: ${JSON.stringify(newConfig)}`,
  setArgsErr: 'set requires an existing key and exactly one value.',
  getArgsErr: 'get accepts at most one key.',
  resetArgsErr: 'reset accepts no arguments.',
  setDneErr: (keys: string) => `"${keys}" doesn't exist in config. Use ballin config get to inspect available keys.`,
  setObjErr: (keys: string) => `"${keys}" is not a bottom-level value. Choose an existing leaf key.`,
};

const isFileSystemError = (error: unknown): error is NodeJS.ErrnoException => (
  error instanceof Error && 'code' in error && typeof error.code === 'string'
  // System errno codes and oversized files are operational; invalid API arguments are bugs.
  && /^(?:E[A-Z0-9]+|UNKNOWN|ERR_FS_FILE_TOO_LARGE)$/.test(error.code)
);

const recoveryGuidance = (bundled: boolean): string => (
  bundled
    ? 'Check the Ballin installation\'s bundled default config.'
    : 'Run ballin config reset to restore defaults.'
);

const readConfigFile = (filePath: string, bundled = false) => {
  const description = bundled ? 'Bundled default config' : 'Config';
  let configJSON: string;
  try {
    configJSON = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    const guidance = error.code === 'ENOENT' && !bundled
      ? recoveryGuidance(false)
      : 'Check that the config file is accessible and readable.';
    throw new ConfigError(`Unable to read ${description.toLowerCase()}. ${guidance}`);
  }

  let configObj: ConfigObject;
  try {
    configObj = JSON.parse(configJSON) as ConfigObject;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`${description} is not valid JSON. ${recoveryGuidance(bundled)}`);
  }
  return { configObj, configJSON };
};

const validateConfigObject = (configObj: ConfigObject, bundled = false): void => {
  if (configObj === null || typeof configObj !== 'object' || Array.isArray(configObj)) {
    const description = bundled ? 'Bundled default config' : 'Config';
    throw new ConfigError(`${description} must contain a JSON object. ${recoveryGuidance(bundled)}`);
  }
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
  const fetchConfig = () => readConfigFile(configPath);

  const readObjectConfig = () => {
    const config = fetchConfig();
    validateConfigObject(config.configObj);
    return config;
  };

  const writeConfig = (configJSON: string): void => {
    try {
      fs.writeFileSync(configPath, configJSON, 'utf8');
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      throw new ConfigError('Unable to save config. Check that the config file and its parent directory are writable.');
    }
  };

  const readPreviousConfigForReset = (): ResetPreviousConfigResult => {
    try {
      return { display: fs.readFileSync(configPath, 'utf8') };
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      return { display: 'Unable to read previous config.\n' };
    }
  };

  const getConfig = (keys?: string, val?: string): ConfigValue | string => {
    if (val !== undefined) throw new ConfigError(configMessages.getArgsErr, 2);
    const { configObj, configJSON } = readObjectConfig();
    if (keys !== undefined) {
      const { value, missingKeys } = getNestedValue(configObj, keys);
      if (missingKeys !== undefined) throw new ConfigError(configMessages.getKeysDneErr(missingKeys));
      return value as ConfigValue;
    }
    return configJSON;
  };

  const resetConfig = () => {
    const { display: prevConfig } = readPreviousConfigForReset();
    const { configObj, configJSON: defaultConfig } = readConfigFile(defaultConfigPath, true);
    validateConfigObject(configObj, true);
    writeConfig(defaultConfig);
    return configMessages.reset(prevConfig, defaultConfig);
  };

  const setConfig = (keys?: string, val?: ConfigValue, other?: string[]) => {
    if ((other && other.length) || !keys || val === undefined) {
      throw new ConfigError(configMessages.setArgsErr, 2);
    }
    const { configObj } = readObjectConfig();
    const keysArr = keys.split('.');
    const keyToSet = keysArr.pop() as string;
    const parentKeys = keysArr;
    // Resolve the parent first: setConfig updates existing leaves and never creates paths.
    const { value: nestedObj, missingKeys } = parentKeys.length
      ? getNestedValue(configObj, parentKeys.join('.'))
      : { value: configObj };
    if (missingKeys !== undefined) {
      throw new ConfigError(configMessages.setDneErr(missingKeys));
    }
    if (nestedObj === null || typeof nestedObj !== 'object') {
      throw new ConfigError(configMessages.setDneErr(keys));
    }
    if (!hasOwn(nestedObj, keyToSet)) {
      throw new ConfigError(configMessages.setDneErr(keys));
    }
    const prevVal = nestedObj[keyToSet];

    // Objects are containers, but null is a valid leaf value (for example, backup.id).
    if (typeof prevVal === 'object' && prevVal !== null) {
      throw new ConfigError(configMessages.setObjErr(keys));
    }
    nestedObj[keyToSet] = val;
    writeConfig(stringify(configObj));
    return configMessages.set(keys, val);
  };

  const readLeafValue = (keys: string): ConfigLeaf | undefined => {
    try {
      const { configObj } = readObjectConfig();
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
      setConfig(keys, value);
      return true;
    } catch {
      return false;
    }
  };

  return {
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
  ConfigError,
  configMessages,
  createConfigStore,
  stringify,
};

export type { ConfigError };
