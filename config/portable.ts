const fs = require('fs');

type ConfigObject = Record<string, unknown>;
type BackupInclusion = {
  includeRaw: boolean;
  includeDetailed: boolean;
};
type InclusionProposals = Partial<BackupInclusion>;

class PortableConfigError extends Error {}

// These permissions are intentionally independent of each other and of defaults.
const exportedUpdateKeys = [
  'cleanup', 'selfUpdate', 'backup', 'softwareupdate', 'npm', 'nvm',
] as const;
const restoredUpdateKeys = [
  'cleanup', 'selfUpdate', 'backup', 'softwareupdate', 'npm', 'nvm',
] as const;
const exportedInclusionKeys = ['includeRaw', 'includeDetailed'] as const;
const restoredInclusionKeys = ['includeRaw', 'includeDetailed'] as const;

const hasOwn = (value: ConfigObject, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const isObject = (value: unknown): value is ConfigObject => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const requireObject = (value: unknown, key: string): ConfigObject => {
  if (!isObject(value)) {
    throw new PortableConfigError(`Invalid ${key}; expected a JSON object.`);
  }
  return value;
};

const objectSection = (config: ConfigObject, key: string): ConfigObject | undefined => (
  hasOwn(config, key) && isObject(config[key]) ? config[key] : undefined
);

const requireOptionalSection = (config: ConfigObject, key: string): ConfigObject => (
  hasOwn(config, key) ? requireObject(config[key], key) : {}
);

const parseBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

const requireBoolean = (value: unknown, key: string): boolean => {
  const parsed = parseBoolean(value);
  if (parsed === null) {
    throw new PortableConfigError(`Invalid ${key}; expected true or false.`);
  }
  return parsed;
};

const setLeaf = (config: ConfigObject, section: string, key: string, value: string): void => {
  const target = objectSection(config, section) ?? {};
  target[key] = value;
  config[section] = target;
};

const parseConfig = (contents: string): unknown => {
  try {
    return JSON.parse(contents);
  } catch {
    throw new PortableConfigError('Config is not valid JSON.');
  }
};

const readConfig = (configPath: string, allowMissing: boolean): unknown => {
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new PortableConfigError('Unable to read config.');
  }
  return parseConfig(contents);
};

const validateSetupObject = (config: unknown): ConfigObject => {
  const object = requireObject(config, 'config');
  ['update', 'backup', 'analytics'].forEach((section) => requireOptionalSection(object, section));
  return object;
};

// Capture this before configure() fills defaults, so existing choices stay authoritative.
const readSetupConfigContext = (configPath: string): ConfigObject => (
  validateSetupObject(readConfig(configPath, true))
);

const projectPortablePreferences = (input: unknown): ConfigObject => {
  const config = requireObject(input, 'config');
  const update = requireOptionalSection(config, 'update');
  const backup = requireOptionalSection(config, 'backup');
  const projected: ConfigObject = {};

  exportedUpdateKeys.forEach((key) => {
    if (hasOwn(update, key)) {
      setLeaf(projected, 'update', key, String(requireBoolean(update[key], `update.${key}`)));
    }
  });
  exportedInclusionKeys.forEach((key) => {
    if (hasOwn(backup, key)) {
      setLeaf(projected, 'backup', key, String(requireBoolean(backup[key], `backup.${key}`)));
    }
  });

  const analytics = objectSection(config, 'analytics');
  if (analytics && hasOwn(analytics, 'enabled') && analytics.enabled === 'false') {
    setLeaf(projected, 'analytics', 'enabled', 'false');
  }
  return projected;
};

const restorePortablePreferences = (
  localConfig: ConfigObject,
  originalConfig: ConfigObject,
  remoteInput: unknown,
): { config: ConfigObject; inclusionProposals: InclusionProposals } => {
  validateSetupObject(localConfig);
  validateSetupObject(originalConfig);
  const remote = requireObject(remoteInput, 'remote config');
  const config = structuredClone(localConfig);
  const inclusionProposals: InclusionProposals = {};
  const originalUpdate = objectSection(originalConfig, 'update') ?? {};
  const remoteUpdate = objectSection(remote, 'update') ?? {};

  restoredUpdateKeys.forEach((key) => {
    if (hasOwn(originalUpdate, key) || !hasOwn(remoteUpdate, key)) return;
    const value = parseBoolean(remoteUpdate[key]);
    if (value !== null) setLeaf(config, 'update', key, String(value));
  });

  const originalAnalytics = objectSection(originalConfig, 'analytics') ?? {};
  const remoteAnalytics = objectSection(remote, 'analytics') ?? {};
  if (
    !hasOwn(originalAnalytics, 'enabled')
    && hasOwn(remoteAnalytics, 'enabled')
    && remoteAnalytics.enabled === 'false'
  ) {
    setLeaf(config, 'analytics', 'enabled', 'false');
  }

  const originalBackup = objectSection(originalConfig, 'backup') ?? {};
  const remoteBackup = objectSection(remote, 'backup') ?? {};
  restoredInclusionKeys.forEach((key) => {
    if (hasOwn(originalBackup, key) || !hasOwn(remoteBackup, key)) return;
    const value = parseBoolean(remoteBackup[key]);
    if (value === true) inclusionProposals[key] = true;
    if (value === false) setLeaf(config, 'backup', key, 'false');
  });

  return { config, inclusionProposals };
};

const resolveBackupInclusion = (input: unknown): BackupInclusion => {
  const config = requireObject(input, 'config');
  const backup = requireOptionalSection(config, 'backup');
  return {
    includeRaw: hasOwn(backup, 'includeRaw')
      ? requireBoolean(backup.includeRaw, 'backup.includeRaw') : false,
    includeDetailed: hasOwn(backup, 'includeDetailed')
      ? requireBoolean(backup.includeDetailed, 'backup.includeDetailed') : false,
  };
};

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new PortableConfigError('Expected one config file.');
    const projected = projectPortablePreferences(readConfig(process.argv[2], false));
    process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof PortableConfigError ? error.message : 'Unable to export portable preferences.';
    process.stderr.write(`ballin preferences: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PortableConfigError,
  projectPortablePreferences,
  readSetupConfigContext,
  resolveBackupInclusion,
  restorePortablePreferences,
};

export type { BackupInclusion, ConfigObject, InclusionProposals, PortableConfigError };
