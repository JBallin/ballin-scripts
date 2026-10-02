type ConfigObject = { [key: string]: unknown };
type RepositoryDestination = { id: string; ownerId: string; name: string; branch: string };
type BackupDestination =
  | { kind: 'unconfigured' }
  | { kind: 'invalid' }
  | { kind: 'repository'; repository: RepositoryDestination }
  | { kind: 'legacy-gist'; id: string; host: string | null };
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

const validRepositoryName = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
  && value !== '.' && value !== '..'
);

const nonemptyIdentifier = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value)
);

const configuredBackupDestination = (config: ConfigObject): BackupDestination => {
  if (!isConfigObject(config) || (config.backup !== undefined && !isConfigObject(config.backup))) {
    return { kind: 'invalid' };
  }
  const backup = isConfigObject(config.backup) ? config.backup : {};
  const legacy = backupDestinationFromConfig(config);
  if (legacy.idStatus === 'invalid') return { kind: 'invalid' };
  const repository = backup.repository;
  if (repository !== undefined && repository !== null) {
    if (
      legacy.id || !isConfigObject(repository)
      || !nonemptyIdentifier(repository.id) || !nonemptyIdentifier(repository.ownerId)
      || !validRepositoryName(repository.name) || !nonemptyIdentifier(repository.branch)
    ) return { kind: 'invalid' };
    return { kind: 'repository', repository: {
      id: repository.id, ownerId: repository.ownerId, name: repository.name, branch: repository.branch,
    } };
  }
  return legacy.id
    ? { kind: 'legacy-gist', id: legacy.id, host: legacy.host }
    : { kind: 'unconfigured' };
};

const sensitiveSourceConsent = (config: ConfigObject): boolean | null => {
  const backup = isConfigObject(config.backup) ? config.backup : {};
  const value = backup.includeSensitive;
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return null;
};

module.exports = {
  backupDestinationFromConfig,
  configuredBackupDestination,
  classifyBackupId,
  isConfigObject,
  normalizeBackupHost,
  sensitiveSourceConsent,
  validRepositoryName,
};

export type {
  BackupIdState,
  BackupIdStatus,
  ConfigObject,
  BackupDestination,
  RepositoryDestination,
};
