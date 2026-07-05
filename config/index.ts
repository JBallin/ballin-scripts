const path = require('path');
const {
  configMessages,
  createConfigStore,
  stringify,
} = require('./store.ts');

const userConfigPath = path.join(__dirname, '..', 'ballin.config.json');
const configPath = process.env.BALLIN_TEST_CONFIG_PATH || userConfigPath;
const defaultConfigPath = path.join(__dirname, '.defaultConfig.json');
const store = createConfigStore({ configPath, defaultConfigPath });
const {
  configAction,
  fetchConfig,
  getConfig,
  setConfig,
} = store;

module.exports = {
  getConfig,
  setConfig,
  configAction,
  stringify,
  configPath,
  fetchConfig,
  configMessages,
};
