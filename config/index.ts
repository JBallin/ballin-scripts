const path = require('path');
const {
  ConfigError,
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

const configAction = (args: string[] = []) => {
  const [request, keys, value, ...other] = args;
  if (request === 'reset') {
    if (args.length !== 1) throw new ConfigError(configMessages.resetArgsErr, 2);
    return resetConfig();
  }
  // Send full config when no explicit request is provided.
  if (request === 'get' || !request) {
    if (args.length > 2) throw new ConfigError(configMessages.getArgsErr, 2);
    return getConfig(keys);
  }
  if (request === 'set') return setConfig(keys, value, other);
  throw new ConfigError(configMessages.actionErr, 2);
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
