const { exec } = require('child_process');
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
  fetchConfig,
  getConfig,
  resetConfig,
  setConfig,
} = store;

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

module.exports = {
  getConfig,
  setConfig,
  configAction,
  stringify,
  configPath,
  fetchConfig,
  configMessages,
};
