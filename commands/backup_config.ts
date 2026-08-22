type ConfigObject = { [key: string]: unknown };
type BackupIdStatus = 'unconfigured' | 'configured' | 'invalid';
type BackupIdState = {
  id: string | null;
  status: BackupIdStatus;
};

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const classifyBackupId = (value: unknown): BackupIdState => {
  if (value === undefined || value === null) {
    return { id: null, status: 'unconfigured' };
  }
  if (typeof value !== 'string') {
    return { id: null, status: 'invalid' };
  }

  const id = value.trim();
  return id && id !== 'null'
    ? { id, status: 'configured' }
    : { id: null, status: 'unconfigured' };
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
  idStatus: BackupIdStatus;
} => {
  const backup = isConfigObject(config.backup) ? config.backup : {};
  const idState = classifyBackupId(backup.id);
  return {
    host: normalizeBackupHost(backup.host),
    id: idState.id,
    idStatus: idState.status,
  };
};

module.exports = {
  backupDestinationFromConfig,
  classifyBackupId,
  isConfigObject,
  normalizeBackupHost,
};

export type {
  BackupIdState,
  BackupIdStatus,
  ConfigObject,
};
