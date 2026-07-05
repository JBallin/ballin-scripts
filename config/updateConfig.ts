/* eslint-disable no-console */

const fs = require('fs');
const { configPath, fetchConfig, stringify } = require('./index.ts');
const defaultConfig = require('./.defaultConfig.json');

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
  fs.writeFileSync(configPath, stringify(userConfig), 'utf-8');
}

if (updates.length) {
  console.log('New configuration options have been added! Here are the updates:');
  updates.forEach((update) => {
    console.log(update);
  });
}
