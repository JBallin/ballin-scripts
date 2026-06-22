/* eslint-disable no-console */

const fs = require('fs');
const { configPath, fetchConfig, stringify } = require('.');
const defaultConfig = require('./.defaultConfig.json');

const { configObj: userConfig } = fetchConfig();
const updates = [];

Object.keys(defaultConfig).forEach((key) => {
  const defaultVal = defaultConfig[key];
  if (!(key in userConfig)) {
    userConfig[key] = defaultVal;
    updates.push(`${key}: ${defaultVal}`);
  }
  if (typeof defaultVal === 'object' && defaultVal !== 'null') {
    Object.keys(defaultVal).forEach((nestedKey) => {
      if (!(nestedKey in userConfig[key])) {
        const nestedDefaultVal = defaultVal[nestedKey];
        userConfig[key][nestedKey] = nestedDefaultVal;
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
