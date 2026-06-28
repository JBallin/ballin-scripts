/* eslint-disable no-console */

const fs = require('fs');
const { configPath, fetchConfig, stringify } = require('./index.ts');
const defaultConfig = require('./.defaultConfig.json');

type ConfigLeaf = string | number | boolean | null;
type ConfigObject = { [key: string]: ConfigValue };
type ConfigValue = ConfigLeaf | ConfigObject;

const { configObj: userConfig } = fetchConfig();
const updates: string[] = [];

const hostFromLegacyGistUrl = (url: ConfigValue): string | null => {
  if (typeof url !== 'string' || !url) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'gist.github.com') {
      return 'github.com';
    }
    if (hostname.startsWith('gist.')) {
      return hostname.slice('gist.'.length);
    }
    return hostname;
  } catch {
    return null;
  }
};

Object.keys(defaultConfig).forEach((key) => {
  const defaultVal = defaultConfig[key] as ConfigValue;
  if (!(key in userConfig)) {
    userConfig[key] = defaultVal;
    updates.push(`${key}: ${defaultVal}`);
  }
  if (typeof defaultVal === 'object' && (defaultVal as unknown) !== 'null') {
    Object.keys(defaultVal as ConfigObject).forEach((nestedKey) => {
      const nestedUserConfig = userConfig[key] as ConfigObject;
      const nestedDefaultConfig = defaultVal as ConfigObject;
      if (!(nestedKey in nestedUserConfig)) {
        const nestedDefaultVal = key === 'gu' && nestedKey === 'host'
          ? hostFromLegacyGistUrl(nestedUserConfig.url) ?? nestedDefaultConfig[nestedKey]
          : nestedDefaultConfig[nestedKey];
        nestedUserConfig[nestedKey] = nestedDefaultVal;
        updates.push(`${key}.${nestedKey}: ${nestedDefaultVal}`);
      }
    });
  }
});

if (updates.length) {
  fs.writeFileSync(configPath, stringify(userConfig), 'utf-8');
  console.log('New configuration options have been added! Here are the updates:');
  updates.forEach((update) => {
    console.log(update);
  });
}
