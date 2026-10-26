type ConfigObject = { [key: string]: unknown };
type RepositoryDestination = { host: string; id: string; ownerId: string; name: string; branch: string };
type BackupDestination =
  | { kind: 'unconfigured' }
  | { kind: 'invalid' }
  | { kind: 'repository'; repository: RepositoryDestination };

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const validRepositoryName = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
  && value !== '.' && value !== '..'
);

const nonemptyIdentifier = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value)
);

// Hostnames, not arbitrary URLs. Keep API and browser targeting on one authority.
const normalizeBackupHost = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 253 || !/^[A-Za-z0-9.-]+$/u.test(value)) return null;
  const host = value.toLowerCase();
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    ? host : null;
};

const parseBackupSetupArgs = (args: string[]): { repositoryName?: string; hostname?: string } => {
  let repositoryName: string | undefined;
  let hostname: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--hostname' && hostname === undefined) {
      const value = normalizeBackupHost(args[++index]);
      if (!value) throw new Error('Enter a GitHub hostname only, such as github.com or git.example.com.');
      hostname = value;
    } else if (!arg.startsWith('--') && repositoryName === undefined && validRepositoryName(arg)) {
      repositoryName = arg;
    } else {
      throw new Error('Expected one repository name and at most one --hostname <host> option.');
    }
  }
  return { repositoryName, hostname };
};

const configuredBackupDestination = (config: ConfigObject): BackupDestination => {
  if (!isConfigObject(config) || (config.backup !== undefined && !isConfigObject(config.backup))) {
    return { kind: 'invalid' };
  }
  const backup = isConfigObject(config.backup) ? config.backup : {};
  const repository = backup.repository;
  if (repository !== undefined && repository !== null) {
    if (
      !isConfigObject(repository)
      || !nonemptyIdentifier(repository.id) || !nonemptyIdentifier(repository.ownerId)
      || !validRepositoryName(repository.name) || !nonemptyIdentifier(repository.branch)
    ) return { kind: 'invalid' };
    // Old repository linkage always means GitHub.com, even beside a stale backup.host.
    const host = Object.hasOwn(repository, 'host') ? normalizeBackupHost(repository.host) : 'github.com';
    if (!host) return { kind: 'invalid' };
    return { kind: 'repository', repository: {
      host, id: repository.id, ownerId: repository.ownerId, name: repository.name, branch: repository.branch,
    } };
  }
  return { kind: 'unconfigured' };
};

const resolveBackupSetupHost = (config: ConfigObject, hostname?: string): string | undefined => {
  const destination = configuredBackupDestination(config);
  if (hostname !== undefined && normalizeBackupHost(hostname) !== hostname) {
    throw new Error('Enter a GitHub hostname only, such as github.com or git.example.com.');
  }
  if (destination.kind === 'repository') {
    if (hostname !== undefined && hostname !== destination.repository.host) {
      throw new Error('The hostname does not match the configured backup. Disconnect before choosing another host.');
    }
    return destination.repository.host;
  }
  return hostname;
};

const sensitiveSourceConsent = (config: ConfigObject): boolean | null => {
  const backup = isConfigObject(config.backup) ? config.backup : {};
  const value = backup.includeSensitive;
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return null;
};

module.exports = {
  configuredBackupDestination,
  isConfigObject,
  sensitiveSourceConsent,
  validRepositoryName,
  normalizeBackupHost,
  parseBackupSetupArgs,
  resolveBackupSetupHost,
};

export type {
  ConfigObject,
  BackupDestination,
  RepositoryDestination,
};
