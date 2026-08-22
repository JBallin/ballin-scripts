type ConfigObject = { [key: string]: unknown };

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeBackupId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const id = value.trim();
  return id && id !== 'null' ? id : null;
};

const normalizeBackupHost = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const host = value.trim();
  return host || null;
};

const backupDestinationFromConfig = (config: ConfigObject): {
  host: string | null;
  id: string | null;
} => {
  const backup = isConfigObject(config.backup) ? config.backup : {};
  return {
    host: normalizeBackupHost(backup.host),
    id: normalizeBackupId(backup.id),
  };
};

module.exports = {
  backupDestinationFromConfig,
  isConfigObject,
  normalizeBackupHost,
  normalizeBackupId,
};

export type {
  ConfigObject,
};
