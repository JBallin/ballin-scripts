const fs = require('fs');
const { saveBackupConfig, offerAutomaticUpdateBackup, selectSensitiveSources } = require('./backup_preferences.ts');
const { readSetupConfigContext, restorePortablePreferences, PortableConfigError } = require('../config/portable.ts');
const { configuredBackupDestination, isConfigObject, validRepositoryName } = require('./backup_config.ts');
const { configSnapshotFileName } = require('./backup_snapshots.ts');
const { readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');
const {
  readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead,
  createRepositoryBackup, ensureManagedBranchRuleset, repositoryUrl, repositoryMessages,
  sameRepositoryRevision, unexpectedRepositoryEntries,
} = require('./backup_repository.ts');
import type { RepositoryRead, RepositoryError, ManagedBranchRulesetOutcome } from './backup_repository.ts';

// Preserve the established legacy/automatic-backup prompt semantics.
const readPrompt = (prompt: string, eofResponse = ''): string => {
  const line = readPromptLine(prompt);
  return line.eof && !line.text ? eofResponse : line.text;
};
const invalidateBackupCache = (cacheDir: string): boolean => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); return true; } catch {
    writeStdoutLine('Unable to invalidate local backup comparison state. Check cache access and retry.');
    return false;
  }
};
const cancelled = (): false => {
  writeStdoutLine('Backup setup cancelled; no destination, consent, cache, or remote changes were made.');
  return false;
};
const reportManagedBranchProtection = (outcome: ManagedBranchRulesetOutcome): void => {
  if (outcome.status === 'present' || outcome.status === 'unsupported') return;
  if (outcome.status === 'enabled') {
    writeStdoutLine('GitHub branch protection enabled.');
    return;
  }
  if (outcome.status === 'permission-denied') {
    writeStdoutLine('Optional GitHub branch protection was not enabled with the current permissions; backup setup can continue normally. Rerun `ballin backup setup` after updating GitHub access.');
    return;
  }
  if (outcome.status === 'unexpected') {
    writeStdoutLine('Backup setup can continue normally, but optional GitHub branch protection could not be confirmed.');
    return;
  }
  writeStdoutLine('Backup setup can continue normally, but optional GitHub branch protection is unconfirmed. Inspect the Ballin-named repository ruleset before retrying setup.');
};
type RepositorySetupOptions = {
  configPath: string; backupCacheDir: string; originalConfig: Record<string, unknown>; repositoryName?: string;
};
const configureRepositoryBackup = (options: RepositorySetupOptions): boolean => {
  const { configPath, backupCacheDir, originalConfig, repositoryName } = options;
  let recoveryUrl: string | undefined;
  let remoteMayExist = false;
  let remoteInitialized = false;
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
      const start = readPromptLine('Set up optional private backups now? [y/N] ');
      if (start.eof || !/^[yY]$/u.test(start.text)) {
        writeStdoutLine('Backup setup skipped. Run `ballin backup setup` when you are ready.');
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
      reportManagedBranchProtection(ensureManagedBranchRuleset(read));
      writeStdoutLine('Validated the configured private backup; local consent and automatic-backup choices were preserved.');
      return true;
    }
    const choice = readPromptLine('Reconnect to an existing backup or create a new one? [reconnect/create] ');
    if (choice.eof || !['reconnect', 'create'].includes(choice.text)) return cancelled();
    const nameLine = repositoryName === undefined ? readPromptLine('Repository name [ballin-backups]: ') : { text: repositoryName, eof: false };
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
    const includeSensitive = selectSensitiveSources();
    if (includeSensitive === null) return cancelled();
    if (includeSensitive === undefined) return false;
    const confirmation = readPromptLine('Confirm this destination and source selection? [y/N] ');
    if (confirmation.eof || !/^[yY]$/u.test(confirmation.text)) return cancelled();
    remoteMayExist = true;
    const read: RepositoryRead = previous
      ? requireRepositoryRead(inspectRepository(previous.destination))
      : createRepositoryBackup(name, account);
    if (previous && !sameRepositoryRevision(read, previous)) {
      writeStdoutLine(repositoryMessages.moved); return false;
    }
    remoteInitialized = true;
    reportManagedBranchProtection(ensureManagedBranchRuleset(read));
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
    writeStdoutLine(`"backup.includeSensitive" set to: ${JSON.stringify(String(includeSensitive))}`);
    return offerAutomaticUpdateBackup(configPath);
  } catch (error) {
    writeStdoutLine(error instanceof PortableConfigError ? (error as Error).message
      : repositoryMessages[(error as RepositoryError).problem] ?? 'Unable to prepare backup configuration.');
    if (remoteMayExist && recoveryUrl) {
      writeStdoutLine(remoteInitialized
        ? `The initialized backup remains available at ${recoveryUrl}; local linkage was not saved. Reconnect to this repository; do not create a duplicate.`
        : (error as RepositoryError).completedStage === 'repository-created'
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
      writeStdoutLine('Backup disconnected; writes are disabled, but local cache cleanup is incomplete. Rerun `ballin backup disconnect`.');
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
