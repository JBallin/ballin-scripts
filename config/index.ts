import type { ConfigOperationName } from './commands.ts';
const { isConfigOperationName } = require('./commands.ts') as {
  isConfigOperationName: (value: unknown) => value is ConfigOperationName;
};
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
  // The empty-operation forms keep the same get behavior and argument validation.
  const operation = request || 'get';
  if (!isConfigOperationName(operation)) throw new ConfigError(configMessages.actionErr, 2);
  switch (operation) {
    case 'reset':
      if (args.length !== 1) throw new ConfigError(configMessages.resetArgsErr, 2);
      return resetConfig();
    case 'get':
      if (args.length > 2) throw new ConfigError(configMessages.getArgsErr, 2);
      return getConfig(keys);
    case 'set':
      return setConfig(keys, value, other);
    /* c8 ignore next 4 -- The catalog predicate supplies the supported operation union; handled cases and the never check enforce that contract. */
    default: {
      const unhandledOperation: never = operation;
      throw new Error(`Unhandled config operation: ${String(unhandledOperation)}`);
    }
  }
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
