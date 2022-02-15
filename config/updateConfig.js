/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { stringify } = require('.');
const defaultConfig = require('./.defaultConfig.json');
const userConfig = require('./ballin.json');

const userConfigPath = path.join(__dirname, 'ballin.json');
const updates = [];

Object.keys(defaultConfig).forEach((key) => {
  const defaultVal = defaultConfig[key];
  if (!(key in userConfig)) {
    userConfig[key] = defaultVal;
    updates.push(`${key}: ${defaultVal}`);
  }
  if (typeof defaultVal === 'object' && defaultVal !== 'null' && !Array.isArray(defaultVal)) {
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
  fs.writeFileSync(userConfigPath, stringify(userConfig), 'utf-8');
  console.log('New configuration options have been added! Here are the updates:');
  updates.forEach((update) => {
    console.log(update);
  });
}
