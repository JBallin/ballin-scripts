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

const ensureConfigSection = (key: string): ConfigObject => {
  if (!isConfigObject(userConfig[key])) {
    userConfig[key] = {};
    configChanged = true;
  }
  return userConfig[key] as ConfigObject;
};

const migrateNestedKey = (
  source: ConfigObject,
  target: ConfigObject,
  sourceKey: string,
  targetKey: string,
  formatKey: string,
): void => {
  if (sourceKey in source && !(targetKey in target)) {
    target[targetKey] = source[sourceKey];
    updates.push(`${formatKey}: ${formatUpdateValue(source[sourceKey])}`);
    configChanged = true;
  }
};

if (isConfigObject(userConfig.up)) {
  const updateConfig = ensureConfigSection('update');
  const legacyUpdateConfig = userConfig.up;
  const legacyUpdateKeyMap: Record<string, string> = {
    cleanup: 'cleanup',
    ballin: 'selfUpdate',
    gu: 'backup',
    softwareupdate: 'softwareupdate',
    npm: 'npm',
    nvm: 'nvm',
  };

  Object.keys(legacyUpdateKeyMap).forEach((legacyKey) => {
    const updateKey = legacyUpdateKeyMap[legacyKey];
    migrateNestedKey(legacyUpdateConfig, updateConfig, legacyKey, updateKey, `update.${updateKey}`);
  });
  delete userConfig.up;
  configChanged = true;
} else if ('up' in userConfig) {
  delete userConfig.up;
  configChanged = true;
}

if (isConfigObject(userConfig.gu)) {
  const backupConfig = ensureConfigSection('backup');
  const legacyBackupConfig = userConfig.gu;

  migrateNestedKey(legacyBackupConfig, backupConfig, 'id', 'id', 'backup.id');
  if ('host' in legacyBackupConfig) {
    migrateNestedKey(legacyBackupConfig, backupConfig, 'host', 'host', 'backup.host');
  } else if (!('host' in backupConfig)) {
    const legacyHost = hostFromLegacyGistUrl(legacyBackupConfig.url);
    if (legacyHost) {
      backupConfig.host = legacyHost;
      updates.push(`backup.host: ${formatUpdateValue(legacyHost)}`);
      configChanged = true;
    }
  }
  delete userConfig.gu;
  configChanged = true;
} else if ('gu' in userConfig) {
  delete userConfig.gu;
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
  fs.writeFileSync(configPath, stringify(userConfig), 'utf-8');
}

if (updates.length) {
  console.log('New configuration options have been added! Here are the updates:');
  updates.forEach((update) => {
    console.log(update);
  });
}
