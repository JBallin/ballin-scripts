const { withTemporaryStatus } = require('./temporaryStatus.ts');
const fs = require('fs');
const { lastBackupSuccessLine } = require('./backup_status.ts');
const { validatedBackupSummary } = require('./backup_summary.ts');
const { saveBackupConfig, offerAutomaticUpdateBackup, selectSensitiveSources } = require('./backup_preferences.ts');
const { readSetupConfigContext, restorePortablePreferences, PortableConfigError } = require('../config/portable.ts');
const { configuredBackupDestination, isConfigObject, validRepositoryName } = require('./backup_config.ts');
const { configSnapshotFileName } = require('./backup_snapshots.ts');
const { readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');
const {
  readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead, inspectRepositoryMaintenance,
  createRepositoryBackup, ensureManagedBranchRuleset, repositoryUrl, repositoryMessages,
  sameRepositoryRevision, unexpectedRepositoryEntries,
} = require('./backup_repository.ts');
import type { RepositoryRead, RepositoryMaintenance, RepositoryError, ManagedBranchRulesetOutcome } from './backup_repository.ts';

const invalidateBackupCache = (cacheDir: string): boolean => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); return true; } catch {
    writeStdoutLine('Unable to invalidate local backup comparison state. Check cache access and retry.');
    return false;
  }
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
  onCancelled?: () => void;
  showValidationSummary?: boolean;
  maintenanceOnly?: boolean;
};
const configureRepositoryBackup = (options: RepositorySetupOptions): boolean => {
  const { configPath, backupCacheDir, originalConfig, repositoryName } = options;
  const cancelled = (): false => {
    writeStdoutLine('Backup setup cancelled; no destination, consent, cache, or remote changes were made.');
    options.onCancelled?.();
    return false;
  };
  let recoveryUrl: string | undefined;
  let remoteMayExist = false;
  let remoteInitialized = false;
  try {
    let candidate = readSetupConfigContext(configPath);
    const configured = configuredBackupDestination(candidate);
    if (configured.kind === 'invalid' || configured.kind === 'legacy-gist') {
      writeStdoutLine('Gist backup support has been retired or the destination configuration is invalid. Run `ballin backup disconnect`, then `ballin backup setup`. Historical Gists remain on GitHub.');
      return false;
    }
    if (repositoryName !== undefined && !validRepositoryName(repositoryName)) {
      writeStdoutLine('Enter a repository name only, using letters, digits, dots, hyphens, or underscores.');
      return false;
    }
    if (configured.kind === 'unconfigured') {
      writeStdoutLine('Ballin backup is optional. Backups are stored in a private GitHub repository.');
      writeStdoutLine('GitHub and anyone authorized to access the repository can read its contents.');
      writeStdoutLine('Inventories and filtered preferences can contain private information or secrets even without sensitive sources.');
      writeStdoutLine('https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#optional-backup-setup-and-reconnect');
      const start = readPromptLine('Set up optional private backups now? [y/N] ');
      if (start.eof || !/^[yY]$/u.test(start.text)) {
        writeStdoutLine('Backup setup skipped. Run `ballin backup setup` when you are ready.');
        return true;
      }
    }
    if (configured.kind === 'repository') {
      const maintain = (): boolean => {
        const account = readRepositoryAccount();
        if (repositoryName !== undefined) {
          const found = candidateRepository(repositoryName, account);
          if (!found || found.id !== configured.repository.id || found.ownerId !== configured.repository.ownerId) {
            writeStdoutLine('That name does not identify the configured backup. Check access; disconnect before choosing a different destination.');
            return false;
          }
        }
        const read: RepositoryRead | RepositoryMaintenance = options.maintenanceOnly
          ? inspectRepositoryMaintenance(configured.repository)
          : requireRepositoryRead(inspectRepository(configured.repository));
        if (read.destination.name !== configured.repository.name) {
          candidate.backup = { ...candidate.backup, repository: read.destination };
          if (!saveBackupConfig(configPath, candidate)) return false;
        }
        reportManagedBranchProtection(ensureManagedBranchRuleset(read));
        const showSummary = options.showValidationSummary !== false;
        const summary = validatedBackupSummary(repositoryUrl(read.destination, account), candidate, showSummary);
        if (summary) writeStdoutLine(summary);
        if (showSummary) writeStdoutLine(lastBackupSuccessLine(backupCacheDir, read.destination));
        return true;
      };
      return maintain();
    }
    const account = readRepositoryAccount();
    writeStdoutLine();
    const choice = readPromptLine('Reconnect to an existing backup or create a new one? [reconnect/create] ');
    if (choice.eof || !['reconnect', 'create'].includes(choice.text)) return cancelled();
    const nameLine = repositoryName === undefined ? readPromptLine('Repository name [ballin-backups]: ') : { text: repositoryName, eof: false };
    if (nameLine.eof) return cancelled();
    const name = nameLine.text || 'ballin-backups';
    if (!validRepositoryName(name)) { writeStdoutLine('Invalid repository name.'); return false; }
    recoveryUrl = `https://github.com/${account.login}/${name}`;
    writeStdoutLine(`\nSelected GitHub.com account: ${account.login}\nCandidate backup: ${recoveryUrl}`);
    const found = candidateRepository(name, account);
    let previous: RepositoryRead | undefined;
    if (choice.text === 'reconnect') {
      if (!found || found.redirected) { writeStdoutLine(repositoryMessages.unavailable); return false; }
      const existing: RepositoryRead = requireRepositoryRead(inspectRepository(found));
      const unexpected = unexpectedRepositoryEntries(existing);
      if (unexpected) writeStdoutLine(`Unrecognized backup entries: ${unexpected}. Ballin will leave them unchanged.`);
      previous = existing;
      const bytes = existing.snapshots.get(configSnapshotFileName);
      if (bytes !== undefined) {
        let remote: unknown;
        try { remote = JSON.parse(bytes.toString('utf8')); } catch {
          writeStdoutLine('Remote ballin_config is not valid JSON.'); return false;
        }
        candidate = restorePortablePreferences(candidate, originalConfig, remote);
      }
      writeStdoutLine('Stop backups from other installations before running `ballin backup` here.');
      writeStdoutLine('Reconnect can recover supported Ballin preferences; existing local choices take precedence.');
      writeStdoutLine('Reconnect does not authorize overwriting different saved data.');
    } else if (found && !found.redirected) {
      writeStdoutLine('That repository name is already in use. Reconnect to a valid backup, or explicitly choose another name.');
      return false;
    }
    if (found?.redirected) {
      writeStdoutLine('This name redirects to a renamed repository. Creating a backup here ends that redirect; links and clones using the old URL will no longer reach the renamed repository.');
    }
    const includeSensitive = selectSensitiveSources();
    if (includeSensitive === null) return cancelled();
    if (includeSensitive === undefined) return false;
    writeStdoutLine(`Confirming ${previous ? 'reconnects to' : 'creates'} this backup, clears local backup comparison state, and saves these choices.`);
    writeStdoutLine('Ballin also attempts optional GitHub branch protection.');
    const confirmation = readPromptLine('Confirm this destination and source selection? [y/N] ');
    if (confirmation.eof || !/^[yY]$/u.test(confirmation.text)) return cancelled();
    remoteMayExist = true;
    const read: RepositoryRead = withTemporaryStatus(previous
      ? 'Checking existing private backup...' : 'Creating and initializing private backup...', () => {
      const read: RepositoryRead = previous
        ? requireRepositoryRead(inspectRepository(previous.destination))
        : createRepositoryBackup(name, account);
      if (!previous || sameRepositoryRevision(read, previous)) {
        remoteInitialized = true;
        reportManagedBranchProtection(ensureManagedBranchRuleset(read));
      }
      return read;
    });
    if (previous && !sameRepositoryRevision(read, previous)) {
      writeStdoutLine(repositoryMessages.moved); return false;
    }
    recoveryUrl = repositoryUrl(read.destination, account);
    if (!invalidateBackupCache(backupCacheDir)) {
      writeStdoutLine(`The remote backup remains available at ${recoveryUrl}; local linkage was not saved.`);
      return false;
    }
    candidate.backup = { ...candidate.backup, repository: read.destination, id: null, includeSensitive: String(includeSensitive) };
    if (!saveBackupConfig(configPath, candidate)) {
      writeStdoutLine(`Reconnect to the existing backup at ${recoveryUrl}; do not create a duplicate.`);
      return false;
    }
    writeStdoutLine(`Private backup ${previous ? 'reconnected' : 'created'}: ${recoveryUrl}`);
    writeStdoutLine(`"backup.includeSensitive" set to: ${JSON.stringify(String(includeSensitive))}`);
    if (!offerAutomaticUpdateBackup(configPath)) return false;
    writeStdoutLine('Backup setup complete.');
    return true;
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
    writeStdoutLine('Backup disconnected. Your remote backup and GitHub authentication are unchanged.');
    return true;
  } catch {
    writeStdoutLine('Unable to read local backup configuration; disconnect did not complete.');
    return false;
  }
};

module.exports = { offerAutomaticUpdateBackup, configureRepositoryBackup, disconnectBackup };
