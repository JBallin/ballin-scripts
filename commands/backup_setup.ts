const { terminalCommand, terminalHeading, terminalError, terminalProse, terminalComplete, terminalEmphasis } = require('./terminalStyle.ts');
const { withTemporaryStatus } = require('./temporaryStatus.ts');
const fs = require('fs');
const { savedPreferenceLine } = require('./preference_confirmation.ts');
const { lastBackupSuccessLine } = require('./backup_status.ts');
const { validatedBackupSummary } = require('./backup_summary.ts');
const {
  saveBackupConfig, selectSensitiveSources, confirmSensitiveSourceChoice,
} = require('./backup_preferences.ts');
const { readSetupConfigContext, restorePortablePreferences, PortableConfigError } = require('../config/portable.ts');
const { configuredBackupDestination, isConfigObject, validRepositoryName, sensitiveSourceConsent, normalizeBackupHost, resolveBackupSetupHost } = require('./backup_config.ts');
const { configSnapshotFileName } = require('./backup_snapshots.ts');
const { commandExists, readPromptLine, readYesNo, promptInputState, CommandInterrupted, rethrowInterruption, writeStdoutLine: writeRawStdoutLine } = require('./commandHelpers.ts');
const writeStdoutLine = (text = ''): void => writeRawStdoutLine(terminalProse(text));
const {
  readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead, inspectRepositoryMaintenance,
  createRepositoryBackup, ensureManagedBranchRuleset, repositoryUrl, formatRepositoryMessage, RepositoryError: RepositoryLookupError,
  sameRepositoryRevision, unexpectedRepositoryEntries,
} = require('./backup_repository.ts');
import type { RepositoryRead, RepositoryMaintenance, RepositoryError, ManagedBranchRulesetOutcome } from './backup_repository.ts';

const invalidateBackupCache = (cacheDir: string): boolean => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); return true; } catch {
    writeStdoutLine('Unable to invalidate local backup comparison state. Check cache access and retry.');
    return false;
  }
};
const reportManagedBranchProtection = (outcome: ManagedBranchRulesetOutcome, installation = false): void => {
  if (outcome.status === 'present' || outcome.status === 'unsupported') return;
  if (outcome.status === 'enabled') {
    if (!installation) writeStdoutLine('GitHub branch protection enabled.');
    return;
  }
  if (outcome.status === 'permission-denied') {
    writeStdoutLine(`ℹ️  Optional GitHub branch protection was not enabled with the current permissions; backup setup can continue normally. Rerun ${terminalCommand('ballin backup setup')} after updating GitHub access.`);
    return;
  }
  if (outcome.status === 'unexpected') {
    writeStdoutLine('ℹ️  Backup setup can continue normally, but optional GitHub branch protection could not be confirmed.');
    return;
  }
  writeStdoutLine('ℹ️  Backup setup can continue normally, but optional GitHub branch protection is unconfirmed. Inspect the Ballin-named repository ruleset before retrying setup.');
};
type RepositorySetupOptions = {
  configPath: string; backupCacheDir: string; originalConfig?: Record<string, unknown>; repositoryName?: string;
  repoDir?: string; docsUrl?: string; configPrepared?: boolean;
  hostname?: string;
  onCancelled?: () => void;
  initialConsent?: boolean;
  presentation?: 'installation' | 'standalone';
  showValidationSummary?: boolean;
  maintenanceOnly?: boolean;
  reviewExistingSettings?: boolean;
};
const configureRepositoryBackup = (options: RepositorySetupOptions): boolean => {
  const { configPath, backupCacheDir, repositoryName } = options;
  if (!options.maintenanceOnly) writeStdoutLine(terminalHeading('Setting up GitHub backup'));
  const { readOriginalSetupConfig, configure, preferenceBoolean } = require('../config/setup.ts');
  const originalConfig = options.originalConfig ?? readOriginalSetupConfig(configPath);
  if (!originalConfig) return false;
  const repoDir = options.repoDir ?? require('path').join(__dirname, '..');
  const complete = (): boolean => {
    if (options.presentation !== 'installation' && !options.maintenanceOnly) {
      writeStdoutLine(`\n${terminalComplete('😎 Setup complete.')}`);
      writeStdoutLine(terminalProse(`Run ${terminalCommand('ballin setup')} to review your other preferences.`));
    }
    return true;
  };
  const checkSetup = <T>(action: () => T): T => (options.reviewExistingSettings || options.presentation === 'installation')
    ? withTemporaryStatus('Checking backup setup…', action) : action();
  const cancelled = (): boolean => {
    writeStdoutLine(`\nBackup setup cancelled.\nRun ${terminalCommand('ballin backup setup')} when you’re ready.`);
    options.onCancelled?.();
    return promptInputState() === 'ended' ? true : false;
  };
  let recoveryUrl: string | undefined;
  let configuredRecoveryUrl: string | undefined;
  let remoteMayExist = false;
  let remoteInitialized = false;
  let linkageSaved = false;
  let host = 'github.com';
  try {
    let candidate = readSetupConfigContext(configPath);
    const configured = configuredBackupDestination(candidate);
    if (configured.kind === 'invalid') {
      throw new PortableConfigError(`The backup destination configuration is invalid. Run ${terminalCommand('ballin backup disconnect')}, then ${terminalCommand('ballin backup setup')}.`);
    }
    let selectedHost: string | undefined;
    try { selectedHost = resolveBackupSetupHost(candidate, options.hostname); }
    catch (error) {
      writeStdoutLine();
      writeStdoutLine(terminalError((error as Error).message));
      return false;
    }
    if (!options.configPrepared && !configure(repoDir, options.docsUrl ?? '', configPath, true)) {
      writeStdoutLine(`\n${terminalError('Unable to prepare local backup configuration.')}\nCheck the config file and its directory, then rerun ${terminalCommand('ballin backup setup')}.`);
      return false;
    }
    candidate = readSetupConfigContext(configPath);
    const originalUpdateState = structuredClone(candidate.update);
    const initiallyUnreviewedNvm = candidate._setup?.unreviewedNvm === true;
    if (repositoryName !== undefined && !validRepositoryName(repositoryName)) {
      writeStdoutLine('Enter a repository name only, using letters, digits, dots, hyphens, or underscores.');
      return false;
    }
    if (configured.kind === 'unconfigured') {
      if (!options.initialConsent && !options.reviewExistingSettings) {
        writeStdoutLine('🔗 Backup details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#optional-backup-setup-and-reconnect');
        if (readYesNo('Set up private backups to GitHub? [y/N] ') !== true) {
          writeStdoutLine(`\nBackup setup skipped.\nRun ${terminalCommand('ballin backup setup')} when you’re ready.`);
          return true;
        }
      }
    }
    if (!commandExists('gh')) throw new RepositoryLookupError('prerequisite');
    if (selectedHost === undefined) {
      const answer = readPromptLine('GitHub hostname [github.com]: ');
      if (answer.eof) return cancelled();
      const normalized = normalizeBackupHost(answer.text || 'github.com');
      if (!normalized) {
        writeStdoutLine('Enter a GitHub hostname only, such as github.com or git.example.com.');
        return false;
      }
      host = normalized;
    } else host = selectedHost;
    if (configured.kind === 'repository') {
      const maintain = (): boolean => {
        const account = readRepositoryAccount(host);
        if (repositoryName !== undefined) {
          const found = candidateRepository(repositoryName, account);
          if (!found || found.id !== configured.repository.id || found.ownerId !== configured.repository.ownerId) {
            writeStdoutLine('That name does not identify the configured backup. Check access; disconnect before choosing a different destination.');
            return false;
          }
        }
        const checked = checkSetup(() => {
          const read: RepositoryRead | RepositoryMaintenance = options.maintenanceOnly
            ? inspectRepositoryMaintenance(configured.repository)
            : requireRepositoryRead(inspectRepository(configured.repository));
          if (read.destination.name !== configured.repository.name) {
            candidate.backup = { ...candidate.backup, repository: read.destination };
            if (!saveBackupConfig(configPath, candidate)) return undefined;
          }
          configuredRecoveryUrl = repositoryUrl(read.destination, account);
          return { read, protection: ensureManagedBranchRuleset(read) };
        });
        if (!checked) return false;
        const { read, protection } = checked;
        reportManagedBranchProtection(protection, options.presentation === 'installation');
        const showSummary = options.showValidationSummary !== false;
        const summary = validatedBackupSummary(repositoryUrl(read.destination, account), candidate, showSummary);
        if (summary) writeStdoutLine(summary);
        if (showSummary) writeStdoutLine(lastBackupSuccessLine(backupCacheDir, read.destination));
        if (!options.reviewExistingSettings) return complete();
        writeStdoutLine(`\n${terminalHeading('Backup preferences')}`);
        const sensitive = sensitiveSourceConsent(candidate);
        if (sensitive === null) throw new PortableConfigError('Invalid `backup.includeSensitive`; expected true or false.');
        try { preferenceBoolean(candidate.update.backup, 'update.backup'); }
        catch (error) { throw new PortableConfigError((error as Error).message); }
        const cancelReview = (): boolean => {
          writeStdoutLine(`\nReview cancelled. Earlier confirmed choices remain saved.\nRun ${terminalCommand('ballin backup setup')} to review them again.`);
          options.onCancelled?.();
          return promptInputState() === 'ended' ? true : false;
        };
        const included = confirmSensitiveSourceChoice(sensitive);
        if (included === null) return cancelReview();
        if (included === undefined) return false;
        const expectedDestination = JSON.stringify(candidate.backup.repository);
        const validateReview = (current: typeof candidate): boolean => {
          const unchanged = JSON.stringify(current.backup.repository) === expectedDestination
            && current.backup.includeSensitive === candidate.backup.includeSensitive;
          if (!unchanged) writeStdoutLine(`Backup configuration changed during review. Run ${terminalCommand('ballin backup setup')} again.`);
          return unchanged;
        };
        const current = readSetupConfigContext(configPath);
        if (!validateReview(current)) return false;
        const previousSensitive = current.backup.includeSensitive;
        current.backup.includeSensitive = String(included);
        if (!saveBackupConfig(configPath, current)) return false;
        writeStdoutLine(savedPreferenceLine('backup.includeSensitive', included, previousSensitive));
        return complete();
      };
      return maintain();
    }
    const account = readRepositoryAccount(host);
    const choice = readPromptLine('Create a new backup or reconnect to an existing one? [CREATE/reconnect] ');
    if (choice.eof) return cancelled();
    const mode = choice.text || 'create';
    if (!['create', 'reconnect'].includes(mode)) return cancelled();
    let suggested: string | undefined = 'ballin-backups';
    let found: (RepositoryRead['destination'] & { redirected?: true }) | null = null;
    if (mode === 'create' && repositoryName === undefined) {
      try {
        found = candidateRepository(suggested, account);
        // Only suggest names checked as missing. Never reuse a collision or a redirect.
        for (let suffix = 2; found && suffix <= 100; suffix += 1) {
          suggested = `ballin-backups-${suffix}`;
          found = candidateRepository(suggested, account);
        }
        if (found) suggested = undefined;
      } catch (error) {
        rethrowInterruption(error);
        // Remote lookup failures are advisory here; local/cleanup and unexpected failures remain fatal.
        const failure = error as RepositoryError;
        if (!(error instanceof RepositoryLookupError) || !['authentication', 'connection', 'timeout', 'request',
          'unavailable', 'identity', 'invalid-data', 'resource-limit'].includes(failure.problem) || failure.cleanupFailed) throw error;
        writeStdoutLine(formatRepositoryMessage(failure.problem, process.stdout, host));
        suggested = undefined;
      }
      if (suggested === undefined) writeStdoutLine('Unable to suggest an available name. Enter a repository name to check.');
      else if (suggested !== 'ballin-backups') writeStdoutLine(`ballin-backups is already in use. Available suggestion: ${suggested}.`);
    }
    let name: string;
    let previous: RepositoryRead | undefined;
    let remotePreferences: unknown;
    while (true) {
      const nameLine = repositoryName === undefined
        ? readPromptLine(suggested === undefined ? 'Repository name: ' : `Repository name [${suggested}]: `) : { text: repositoryName, eof: false };
      if (nameLine.eof) return cancelled();
      name = nameLine.text || suggested || '';
      if (!validRepositoryName(name)) { writeStdoutLine('Invalid repository name.'); return false; }
      found = candidateRepository(name, account);
      if (mode === 'reconnect' && found && !found.redirected) {
        const selected = found;
        const inspection = checkSetup(() => inspectRepository(selected));
        if (inspection.status === 'incomplete' && inspection.missingRepositoryNode
          && !inspection.cleanupFailed && repositoryName === undefined) {
          writeStdoutLine(`⚠️  ${formatRepositoryMessage('unavailable')}`);
          continue;
        }
        previous = requireRepositoryRead(inspection);
      }
      if (mode === 'reconnect' && (!found || found.redirected)) {
        writeStdoutLine(`⚠️  ${formatRepositoryMessage('unavailable')}`);
        if (repositoryName !== undefined) return false;
        continue;
      }
      if (mode !== 'create' || !found || found.redirected) break;
      writeStdoutLine('That repository name is already in use. Choose another name; use Reconnect for an existing backup.');
      if (repositoryName !== undefined) return false;
    }
    recoveryUrl = repositoryUrl({ host, ownerId: account.id, name }, account);
    writeStdoutLine(`Proposed backup: ${recoveryUrl}`);
    if (mode === 'reconnect' && previous) {
      const existing = previous;
      const unexpected = unexpectedRepositoryEntries(existing);
      if (unexpected) writeStdoutLine(`ℹ️  Unrecognized backup entries: ${unexpected}. Ballin will leave them unchanged.`);
      previous = existing;
      const bytes = existing.snapshots.get(configSnapshotFileName);
      if (bytes !== undefined) {
        let remote: unknown;
        try { remote = JSON.parse(bytes.toString('utf8')); } catch {
          writeStdoutLine('Remote ballin_config is not valid JSON.'); return false;
        }
        remotePreferences = remote;
        restorePortablePreferences(candidate, originalConfig, remote);
      }
      writeStdoutLine('⚠️  Stop backups on other installations before backing up here.');
      writeStdoutLine('🔗 Reconnect details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#optional-backup-setup-and-reconnect');
    } else if (found && !found.redirected) {
      writeStdoutLine('That repository name is already in use. Reconnect to a valid backup, or explicitly choose another name.');
      return false;
    }
    if (found?.redirected) {
      writeStdoutLine('ℹ️  This name redirects to a renamed repository. Creating a backup here ends that redirect; links and clones using the old URL will no longer reach the renamed repository.');
    }
    writeStdoutLine(`\n${terminalHeading('Backup preferences')}`);
    const includeSensitive = selectSensitiveSources();
    if (includeSensitive === null) return cancelled();
    if (includeSensitive === undefined) return false;
    const initialDestination = JSON.stringify(candidate.backup.repository);
    const initialSensitive = candidate.backup.includeSensitive;
    const current = readSetupConfigContext(configPath);
    if (JSON.stringify(current.backup.repository) !== initialDestination || current.backup.includeSensitive !== initialSensitive) {
      writeStdoutLine(`Backup configuration changed during review. Run ${terminalCommand('ballin backup setup')} again.`);
      return false;
    }
    const previousSensitive = current.backup.includeSensitive;
    current.backup.includeSensitive = String(includeSensitive);
    if (!saveBackupConfig(configPath, current)) return false;
    if (options.presentation !== 'installation') writeStdoutLine(savedPreferenceLine('backup.includeSensitive', includeSensitive, previousSensitive));
    const validateDestination = (): ReturnType<typeof readSetupConfigContext> | undefined => {
      const latest = readSetupConfigContext(configPath);
      if (JSON.stringify(latest.backup.repository) !== initialDestination || latest.backup.includeSensitive !== String(includeSensitive)) {
        writeStdoutLine(`Backup configuration changed during setup. Run ${terminalCommand('ballin backup setup')} again.`);
        return undefined;
      }
      return latest;
    };
    const confirmation = readYesNo(`\n${previous ? 'Reconnect to' : 'Create'} this private GitHub backup ${includeSensitive ? 'including' : 'without'} sensitive sources? [y/N] `);
    if (confirmation !== true) return cancelled();
    if (!validateDestination()) return false;
    remoteMayExist = true;
    const { read, protection } = withTemporaryStatus(previous
      ? 'Checking existing private backup...' : 'Creating private backup…', () => {
      const read: RepositoryRead = previous
        ? requireRepositoryRead(inspectRepository(previous.destination))
        : createRepositoryBackup(name, account);
      let protection: ManagedBranchRulesetOutcome | undefined;
      if (!previous || sameRepositoryRevision(read, previous)) {
        remoteInitialized = true;
        protection = ensureManagedBranchRuleset(read);
      }
      return { read, protection };
    });
    if (protection) reportManagedBranchProtection(protection, options.presentation === 'installation');
    if (previous && !sameRepositoryRevision(read, previous)) {
      writeStdoutLine(formatRepositoryMessage('moved')); return false;
    }
    recoveryUrl = repositoryUrl(read.destination, account);
    const latest = validateDestination();
    if (!latest) {
      writeStdoutLine(`The remote backup remains available at ${recoveryUrl}; local linkage was not saved.`);
      return false;
    }
    if (!invalidateBackupCache(backupCacheDir)) {
      writeStdoutLine(`The remote backup remains available at ${recoveryUrl}; local linkage was not saved.`);
      return false;
    }
    if (remotePreferences === undefined) candidate = latest;
    else {
      const restoreBaseline = structuredClone(originalConfig);
      const baselineUpdate: Record<string, unknown> = isConfigObject(restoreBaseline.update) ? restoreBaseline.update as Record<string, unknown> : {};
      const initialUpdate = isConfigObject(originalUpdateState) ? originalUpdateState : {};
      const latestUpdate = isConfigObject(latest.update) ? latest.update : {};
      // A local choice changed during setup must take precedence over recovered values.
      for (const key of new Set([...Object.keys(initialUpdate), ...Object.keys(latestUpdate)])) {
        if (JSON.stringify(initialUpdate[key]) !== JSON.stringify(latestUpdate[key])) baselineUpdate[key] = latestUpdate[key];
      }
      if (initiallyUnreviewedNvm && latest._setup?.unreviewedNvm !== true) {
        delete restoreBaseline._setup;
        baselineUpdate.nvm = latestUpdate.nvm;
      }
      restoreBaseline.update = baselineUpdate;
      candidate = restorePortablePreferences(latest, restoreBaseline, remotePreferences);
    }
    candidate.backup = { ...candidate.backup, repository: read.destination };
    if (!saveBackupConfig(configPath, candidate)) {
      writeStdoutLine(`Reconnect to the existing backup at ${recoveryUrl}; do not create a duplicate.`);
      return false;
    }
    linkageSaved = true;
    writeStdoutLine(`Private backup ${previous ? 'reconnected' : 'created'}: ${recoveryUrl}`);
    return complete();
  } catch (error) {
    const interruptedUrl = configuredRecoveryUrl ?? (remoteMayExist ? recoveryUrl : undefined);
    if (error instanceof CommandInterrupted && interruptedUrl) {
      writeStdoutLine(`Remote work may already have completed at ${interruptedUrl}. Inspect it before recovery; do not create a duplicate.`);
    }
    rethrowInterruption(error);
    if (['prerequisite', 'authentication'].includes((error as RepositoryError).problem)) {
      writeStdoutLine();
      if ((error as RepositoryError).problem === 'prerequisite') {
        writeStdoutLine(terminalError(`GitHub CLI (${terminalEmphasis('gh', 'bold')}) was not found on PATH.`));
        writeStdoutLine(terminalProse(`Install it from https://cli.github.com, then run ${terminalCommand('ballin backup setup')}.`));
      } else {
        writeStdoutLine(terminalError('GitHub CLI authentication is required.'));
        writeStdoutLine(terminalProse(`Run ${terminalCommand(`gh auth login --hostname ${host}`)}, then run ${terminalCommand('ballin backup setup')}.`));
      }
    } else {
      const message = error instanceof PortableConfigError ? (error as Error).message
        : formatRepositoryMessage((error as RepositoryError).problem, process.stdout, host) ?? 'Unable to prepare backup configuration.';
      writeStdoutLine();
      writeStdoutLine(terminalError(message));
      if (error instanceof PortableConfigError) writeStdoutLine(`Repair the local configuration, then run ${terminalCommand('ballin backup setup')}.`);
    }
    if (remoteMayExist && recoveryUrl) {
      writeStdoutLine(linkageSaved
        ? `The backup destination is saved locally and remains available at ${recoveryUrl}. Setup is incomplete; run ${terminalCommand('ballin setup')} to review the remaining preferences. Do not create a duplicate.`
        : remoteInitialized
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
    const prior = configuredBackupDestination(config);
    config.backup = { ...(isConfigObject(config.backup) ? config.backup : {}), repository: null };
    config.update = { ...(isConfigObject(config.update) ? config.update : {}), backup: 'false' };
    if (!saveBackupConfig(configPath, config)) return false;
    if (!invalidateBackupCache(cacheDir)) {
      writeRawStdoutLine(`Backup disconnected; writes are disabled, but local cache cleanup is incomplete. Rerun ${terminalCommand('ballin backup disconnect')}.`);
      return false;
    }
    if (prior.kind === 'repository') {
      writeRawStdoutLine(`Backup ${prior.repository.name} on ${prior.repository.host} disconnected.\nYour remote backup and GitHub authentication are unchanged.`);
    } else if (prior.kind === 'unconfigured') {
      writeRawStdoutLine('No backup destination was configured. Automatic backups are disabled.');
    } else {
      writeRawStdoutLine('Invalid local backup destination configuration cleared. Automatic backups are disabled.');
    }
    return true;
  } catch {
    writeRawStdoutLine('Unable to read local backup configuration; disconnect did not complete.');
    return false;
  }
};

module.exports = { configureRepositoryBackup, disconnectBackup };
