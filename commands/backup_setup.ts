const fs = require('fs');
const { createConfigStore, stringify } = require('../config/store.ts');
const { readSetupConfigContext, restorePortablePreferences, PortableConfigError } = require('../config/portable.ts');
const { configuredBackupDestination, isConfigObject, validRepositoryName } = require('./backup_config.ts');
const { snapshotDefinitions, configSnapshotFileName } = require('./backup_snapshots.ts');
const { writeStdoutLine } = require('./commandHelpers.ts');
const {
  readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead,
  createRepositoryBackup, repositoryUrl, repositoryMessages,
  sameRepositoryRevision, unexpectedRepositoryEntries,
} = require('./backup_repository.ts');
import type { RepositoryRead, RepositoryError } from './backup_repository.ts';
import type { SnapshotDefinition } from './backup_snapshots.ts';

// Consent requires a submitted line. Even partial affirmative input followed by EOF cancels.
const readSetupLine = (prompt: string): { text: string; eof: boolean } => {
  process.stdout.write(prompt);
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  while (fs.readSync(0, byte, 0, 1, null) !== 0) {
    if (byte[0] === 10) return { text: Buffer.from(bytes).toString('utf8'), eof: false };
    if (byte[0] !== 13) bytes.push(byte[0]);
  }
  return { text: Buffer.from(bytes).toString('utf8'), eof: true };
};
// Preserve the established legacy/automatic-backup prompt semantics.
const readPrompt = (prompt: string, eofResponse = ''): string => {
  const line = readSetupLine(prompt);
  return line.eof && !line.text ? eofResponse : line.text;
};
const saveBackupConfig = (configPath: string, config: Record<string, unknown>): boolean => {
  const temporary = `${configPath}.${process.pid}.backup.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, stringify(config)); } finally { fs.closeSync(fd); }
    if (process.env.BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT === '1') throw new Error('Simulated final config commit failure');
    fs.renameSync(temporary, configPath);
    return true;
  } catch {
    writeStdoutLine('Unable to save backup configuration; the previous destination and local choices remain authoritative.');
    return false;
  } finally {
    if (created) {
      try { fs.rmSync(temporary, { force: true }); } catch { writeStdoutLine('Unable to remove a private backup configuration staging file.'); }
    }
  }
};
const offerAutomaticUpdateBackup = (configPath: string): boolean => {
  const answer = readPrompt('\n🤔 Automatically run ballin backup after ballin update? [Y/n] ', 'n');
  const preference = answer === '' || answer === 'y' || answer === 'Y' ? 'true' : 'false';
  let saved = false;
  if (createConfigStore({ configPath }).readLeafValue('update.backup') !== undefined) {
    try {
      const config = readSetupConfigContext(configPath);
      config.update.backup = preference;
      saved = saveBackupConfig(configPath, config);
    } catch { /* Retain the already configured destination on a later preference failure. */ }
  }
  if (!saved) {
    writeStdoutLine(`\nℹ️  Backup setup completed, but the automatic update backup preference was not saved. Edit ballin.config.json and set update.backup to ${preference}.`);
    return false;
  }
  writeStdoutLine(`"update.backup" set to: ${JSON.stringify(preference)}`);
  return true;
};
const invalidateBackupCache = (cacheDir: string): boolean => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); return true; } catch {
    writeStdoutLine('Unable to invalidate local backup comparison state. Check cache access and retry.');
    return false;
  }
};
const displayPath = (value: string): string => JSON.stringify(value);
const reviewSensitiveSources = (homeDir: string, env: NodeJS.ProcessEnv): boolean => {
  for (const definition of snapshotDefinitions as SnapshotDefinition[]) {
    if (definition.inclusionGroup !== 'sensitive') continue;
    const observation = definition.discover({ homeDir, env });
    if (observation.status === 'discovery-failed') {
      writeStdoutLine(`Unable to review ${definition.name}: source access failed.`);
      return false;
    }
    if (definition.name === 'pipx') {
      writeStdoutLine(`pipx: ${observation.status}; installation metadata may contain original URLs, credentials, and backend arguments; no collector is run for review.`);
      continue;
    }
    if (observation.status !== 'available') {
      writeStdoutLine(`${definition.name}: ${observation.status}`);
      continue;
    }
    try {
      const logical = observation.source.path;
      if (!logical || observation.source.kind !== 'file') throw new Error('Unsupported review source');
      const resolved = fs.realpathSync(logical);
      if (!fs.statSync(resolved).isFile()) throw new Error('Not a regular file');
      fs.accessSync(resolved, fs.constants.R_OK);
      writeStdoutLine(`${definition.name}: ${displayPath(logical)} -> ${displayPath(resolved)}`);
    } catch {
      writeStdoutLine(`Unable to review ${definition.name}: resolution or read access failed.`);
      return false;
    }
  }
  return true;
};
const cancelled = (): false => {
  writeStdoutLine('Backup setup cancelled; no destination, consent, cache, or remote changes were made.');
  return false;
};
type RepositorySetupOptions = {
  configPath: string; backupCacheDir: string; originalConfig: Record<string, unknown>; repositoryName?: string;
};
const configureRepositoryBackup = (options: RepositorySetupOptions): boolean => {
  const { configPath, backupCacheDir, originalConfig, repositoryName } = options;
  let recoveryUrl: string | undefined;
  let remoteMayExist = false;
  try {
    let candidate = readSetupConfigContext(configPath);
    const configured = configuredBackupDestination(candidate);
    if (configured.kind === 'invalid' || configured.kind === 'legacy-gist') {
      writeStdoutLine('Repair the backup destination configuration before repository setup; legacy migration is separate.');
      return false;
    }
    if (repositoryName !== undefined && !validRepositoryName(repositoryName)) {
      writeStdoutLine('Enter a repository name only, using letters, digits, dots, hyphens, or underscores.');
      return false;
    }
    if (configured.kind === 'unconfigured') {
      writeStdoutLine('Ballin backup is optional. Backups are stored in a private GitHub repository. GitHub and anyone authorized to access the repository can read its contents.');
      const start = readSetupLine('Set up optional private backups now? [y/N] ');
      if (start.eof || !/^[yY]$/u.test(start.text)) {
        writeStdoutLine('Backup setup skipped. Run ballin backup setup when you are ready.');
        return true;
      }
    }
    const account = readRepositoryAccount();
    if (configured.kind === 'repository') {
      if (repositoryName !== undefined) {
        const found = candidateRepository(repositoryName, account);
        if (!found || found.id !== configured.repository.id || found.ownerId !== configured.repository.ownerId) {
          writeStdoutLine('That name does not identify the configured backup. Check access; disconnect before choosing a different destination.');
          return false;
        }
      }
      const read: RepositoryRead = requireRepositoryRead(inspectRepository(configured.repository));
      if (read.destination.name !== configured.repository.name) {
        candidate.backup = { ...candidate.backup, repository: read.destination };
        if (!saveBackupConfig(configPath, candidate)) return false;
      }
      writeStdoutLine('Validated the configured private backup; local consent and automatic-backup choices were preserved.');
      return true;
    }
    const choice = readSetupLine('Reconnect to an existing backup or create a new one? [reconnect/create] ');
    if (choice.eof || !['reconnect', 'create'].includes(choice.text)) return cancelled();
    const nameLine = repositoryName === undefined ? readSetupLine('Repository name [ballin-backups]: ') : { text: repositoryName, eof: false };
    if (nameLine.eof) return cancelled();
    const name = nameLine.text || 'ballin-backups';
    if (!validRepositoryName(name)) { writeStdoutLine('Invalid repository name.'); return false; }
    recoveryUrl = `https://github.com/${account.login}/${name}`;
    writeStdoutLine(`Selected GitHub.com account: ${account.login}\nCandidate backup: ${recoveryUrl}`);
    const found = candidateRepository(name, account);
    let previous: RepositoryRead | undefined;
    if (choice.text === 'reconnect') {
      if (!found) { writeStdoutLine(repositoryMessages.unavailable); return false; }
      const existing: RepositoryRead = requireRepositoryRead(inspectRepository(found));
      writeStdoutLine(`Unexpected retained entries: ${unexpectedRepositoryEntries(existing)}`);
      previous = existing;
      const bytes = existing.snapshots.get(configSnapshotFileName);
      if (bytes !== undefined) {
        let remote: unknown;
        try { remote = JSON.parse(bytes.toString('utf8')); } catch {
          writeStdoutLine('Remote ballin_config is not valid JSON.'); return false;
        }
        candidate = restorePortablePreferences(candidate, originalConfig, remote);
      }
      writeStdoutLine('Retire the previous writer before this installation publishes. Recovery does not establish a comparison base or authorize overwriting different saved data.');
    } else if (found) {
      writeStdoutLine('That repository name is already in use. Reconnect to a valid backup, or explicitly choose another name.');
      return false;
    }
    writeStdoutLine('The fixed inventory and filtered-preference baseline can include private tools, identities, paths, or URLs. It is not guaranteed secret-free.');
    const sensitive = readSetupLine('Also include raw shell/Git/editor configuration, .nvmrc, and pipx installation metadata? [y/N] ');
    if (sensitive.eof) return cancelled();
    const includeSensitive = /^[yY]$/u.test(sensitive.text);
    if (includeSensitive) {
      if (!process.env.HOME) { writeStdoutLine('HOME is required to review sensitive sources.'); return false; }
      if (!reviewSensitiveSources(process.env.HOME, process.env)) return false;
    }
    writeStdoutLine(`Selected: inventory and filtered preferences; sensitive sources ${includeSensitive ? 'included' : 'excluded'}.`);
    writeStdoutLine('Consent covers future captures as files, symlink targets, and installed metadata change; Ballin does not detect or redact credentials. Exclusion does not remove saved history.');
    const confirmation = readSetupLine('Confirm this destination and source selection? [y/N] ');
    if (confirmation.eof || !/^[yY]$/u.test(confirmation.text)) return cancelled();
    remoteMayExist = true;
    const read: RepositoryRead = previous
      ? requireRepositoryRead(inspectRepository(previous.destination))
      : createRepositoryBackup(name, account);
    if (previous && !sameRepositoryRevision(read, previous)) {
      writeStdoutLine(repositoryMessages.moved); return false;
    }
    recoveryUrl = repositoryUrl(read.destination, account);
    writeStdoutLine(`Private backup confirmed: ${recoveryUrl}`);
    if (!invalidateBackupCache(backupCacheDir)) {
      writeStdoutLine(`The remote backup remains available at ${recoveryUrl}; local linkage was not saved.`);
      return false;
    }
    candidate.backup = { ...candidate.backup, repository: read.destination, id: null, includeSensitive: String(includeSensitive) };
    if (!saveBackupConfig(configPath, candidate)) {
      writeStdoutLine(`Reconnect to the existing backup at ${recoveryUrl}; do not create a duplicate.`);
      return false;
    }
    return offerAutomaticUpdateBackup(configPath);
  } catch (error) {
    writeStdoutLine(error instanceof PortableConfigError ? (error as Error).message
      : repositoryMessages[(error as RepositoryError).problem] ?? 'Unable to prepare backup configuration.');
    if (remoteMayExist && recoveryUrl) {
      writeStdoutLine((error as RepositoryError).completedStage === 'repository-created'
        ? `Repository creation completed at ${recoveryUrl}; initialization is unconfirmed. Inspect it deliberately before reconnecting.`
        : `Remote creation or initialization may already have occurred at ${recoveryUrl}. Inspect it; reconnect only if initialized. Do not blindly create another backup.`);
    }
    return false;
  }
};
const disconnectBackup = (configPath: string, cacheDir: string): boolean => {
  try {
    const config = readSetupConfigContext(configPath);
    config.backup = { ...(isConfigObject(config.backup) ? config.backup : {}), repository: null, id: null };
    config.update = { ...(isConfigObject(config.update) ? config.update : {}), backup: 'false' };
    if (!saveBackupConfig(configPath, config)) return false;
    if (!invalidateBackupCache(cacheDir)) {
      writeStdoutLine('Backup disconnected; writes are disabled, but local cache cleanup is incomplete. Rerun ballin backup disconnect.');
      return false;
    }
    writeStdoutLine('Backup disconnected. Remote history and shared gh authentication are unchanged.');
    return true;
  } catch {
    writeStdoutLine('Unable to read local backup configuration; disconnect did not complete.');
    return false;
  }
};

module.exports = { readPrompt, offerAutomaticUpdateBackup, configureRepositoryBackup, disconnectBackup };
