/* eslint-disable no-console */

const { writeConfigFile } = require('./writeConfigFile.ts');
const { configPath, fetchConfig, stringify } = require('./index.ts');
const defaultConfig = require('./.defaultConfig.json');
// Setup records destination and capture consent only in its confirmed transaction.
if (process.env.BALLIN_DEFER_BACKUP_SELECTION === '1') {
  delete defaultConfig.backup.repository;
  delete defaultConfig.backup.includeSensitive;
}

type ConfigLeaf = string | number | boolean | null;
type ConfigObject = { [key: string]: ConfigValue };
type ConfigValue = ConfigLeaf | ConfigObject;

const { configObj: userConfig } = fetchConfig();
const updates: string[] = [];
let configChanged = false;
const isConfigObject = (value: ConfigValue): value is ConfigObject => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const formatUpdateValue = (value: ConfigValue): string => (
  isConfigObject(value) ? JSON.stringify(value) : `${value}`
);

// Preserve an absent NVM choice before supplying false. An explicit saved false
// remains authoritative; this local intent survives until an eligible review.
if (!('update' in userConfig) || (isConfigObject(userConfig.update) && !('nvm' in userConfig.update))) {
  userConfig._setup = { ...(isConfigObject(userConfig._setup) ? userConfig._setup : {}), unreviewedNvm: true };
  configChanged = true;
}

Object.keys(defaultConfig).forEach((key) => {
  const defaultVal = defaultConfig[key] as ConfigValue;
  if (!(key in userConfig)) {
    userConfig[key] = defaultVal;
    updates.push(`${key}: ${formatUpdateValue(defaultVal)}`);
    configChanged = true;
  }
  if (isConfigObject(defaultVal)) {
    if (!isConfigObject(userConfig[key])) {
      userConfig[key] = defaultVal;
      updates.push(`${key}: ${formatUpdateValue(defaultVal)}`);
      configChanged = true;
      return;
    }

    Object.keys(defaultVal as ConfigObject).forEach((nestedKey) => {
      const nestedUserConfig = userConfig[key] as ConfigObject;
      const nestedDefaultConfig = defaultVal as ConfigObject;
      if (!(nestedKey in nestedUserConfig)) {
        const nestedDefaultVal = nestedDefaultConfig[nestedKey];
        nestedUserConfig[nestedKey] = nestedDefaultVal;
        updates.push(`${key}.${nestedKey}: ${formatUpdateValue(nestedDefaultVal)}`);
        configChanged = true;
      }
    });
  }
});

if (configChanged) {
  writeConfigFile(configPath, stringify(userConfig));
}

if (updates.length) {
  console.log('New configuration options have been added! Here are the updates:');
  updates.forEach((update) => {
    console.log(update);
  });
}
