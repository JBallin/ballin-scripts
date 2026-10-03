const { withTemporaryStatus, clearTemporaryStatus } = require('./temporaryStatus.ts');
import type { BackupCommandName } from './backup_commands.ts';
const { isBackupCommandName } = require('./backup_commands.ts') as {
  isBackupCommandName: (value: unknown) => value is BackupCommandName;
};
const { terminalEmphasis } = require('./terminalStyle.ts');
const fs = require('fs');
const path = require('path');
const { recordBehavioralAnalyticsEvent } = require('./analytics.ts');
const {
  configPath,
  fetchConfig,
} = require('../config/index.ts');
const {
  configuredBackupDestination,
  isConfigObject,
  sensitiveSourceConsent,
} = require('./backup_config.ts');
const {
  configure,
  configureBackup,
  disconnectBackup,
  readOriginalSetupConfig,
} = require('./install_setup.ts');
const {
  makeTempFile,
  reportSpawnError,
  removeTempFile,
  runCommand,
  spawnResultStatus,
  writeStderrLine,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  collectSnapshotObservations,
  codexSnapshotFileNames,
  emptySnapshotContent,
  normalizeSnapshotInput,
  observeSnapshotSources,
  snapshotDefinitions,
} = require('./backup_snapshots.ts');
const { snapshotByteLimit, readBoundedFile, requireWithinLimit, SnapshotLimitError } = require('./recursive_snapshot.ts');
const {
  inspectRepository, requireRepositoryRead, publishRepositorySnapshots,
  repositoryCacheDirectory, repositoryMessages, readRepositorySnapshot, repositoryOpenUrl,
  unexpectedRepositoryEntries,
} = require('./backup_repository.ts');
import type { RepositoryDestination } from './backup_config.ts';
import type { RepositoryError, RepositoryRead } from './backup_repository.ts';

import type {
  AvailableSnapshotObservation,
  SnapshotCaptureResult,
  SnapshotCollectionObservation,
  SnapshotCommand,
  SnapshotSourceObservation,
} from './backup_snapshots.ts';

type SnapshotResultState = 'unchanged' | 'created' | 'removed' | 'updated';

type StagedSnapshot = {
  snapshot: SnapshotCommand;
  localFile: string;
};

type RemoteSnapshot = {
  file: string | null;
  exists: boolean;
};

type EvaluatedSnapshot = StagedSnapshot & {
  cacheFile: string;
  cacheNeedsPromotion: boolean;
  resultState: SnapshotResultState;
  shouldUpload: boolean;
};

type BackupConfigResult = {
  config: { repository: RepositoryDestination; includeSensitive: boolean | null } | null;
  exitStatus: number;
};

const backupSetupDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';

const backupFileSortKey = (fileName: string): string => (
  fileName === 'Brewfile' ? 'brew' : fileName.toLowerCase()
);

const compareBackupFileNames = (left: string, right: string): number => {
  const leftKey = backupFileSortKey(left);
  const rightKey = backupFileSortKey(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

const suggestionFileNames = snapshotDefinitions
  .map(({ name }: { name: string }) => name)
  .toSorted(compareBackupFileNames);

const fileSuggestions = `\n${suggestionFileNames.map((name: string) => `  ${name}`).join('\n')}`;

const backupConfig = (): BackupConfigResult => {
  let configObj: Record<string, unknown>;
  try {
    ({ configObj } = fetchConfig());
    if (
      !isConfigObject(configObj)
      || (
        Object.prototype.hasOwnProperty.call(configObj, 'backup')
        && !isConfigObject(configObj.backup)
      )
    ) {
      writeStderrLine('ballin backup: configuration must contain JSON objects');
      return { config: null, exitStatus: 1 };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(`Unable to read config: ${message}`);
    return { config: null, exitStatus: 1 };
  }

  const destination = configuredBackupDestination(configObj);
  if (destination.kind === 'repository') {
    return { config: { repository: destination.repository, includeSensitive: sensitiveSourceConsent(configObj) }, exitStatus: 0 };
  }
  if (destination.kind === 'legacy-gist') {
    writeStderrLine('ballin backup: Gist backup support has been retired. Run `ballin backup disconnect`, then `ballin backup setup`. Historical Gists remain on GitHub.');
  } else if (destination.kind === 'invalid') {
    writeStderrLine('ballin backup: invalid or conflicting destination configuration; repair the local configuration or run `ballin backup disconnect`, then `ballin backup setup`.');
  } else {
    writeStderrLine("ballin backup: backup is not configured; run `ballin backup setup` to enable it");
  }
  return { config: null, exitStatus: 1 };
};

const fileExists = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const writeFileToStderr = (filePath: string): void => {
  if (fs.statSync(filePath).size > 0) {
    clearTemporaryStatus();
    process.stderr.write(fs.readFileSync(filePath));
  }
};

const reportTemporaryCleanupFailure = (): void => {
  writeStderrLine('ballin backup: private temporary-file cleanup is incomplete; completed remote and cache effects are retained');
};

const removeTransportFile = (file: string): void => {
  try { removeTempFile(file); } catch {
    reportTemporaryCleanupFailure();
    throw new Error('Unable to remove a private backup transport file');
  }
};

const captureSnapshotInput = (snapshot: SnapshotCommand, inputFile: string): boolean => {
  const outputFd = fs.openSync(inputFile, 'w');
  const stderrFile = makeTempFile('ballin-backup-stderr-');
  const stderrFd = fs.openSync(stderrFile, 'w');
  let result: ReturnType<typeof runCommand>;
  try {
    result = runCommand(snapshot.command, snapshot.args ?? [], {
      cwd: snapshot.cwd,
      env: snapshot.env,
      stdio: ['ignore', outputFd, stderrFd],
    });
  } finally {
    fs.closeSync(outputFd);
    fs.closeSync(stderrFd);
  }

  if (!(snapshot.suppressStderrOnSuccess && result.status === 0)) {
    writeFileToStderr(stderrFile);
  }
  if (result.error) {
    reportSpawnError(snapshot.command, result.error);
  }
  removeTransportFile(stderrFile);

  return result.status === 0 && !result.error;
};

const snapshotFilesMatch = (leftFile: string, rightFile: string, boundLeft = false): boolean => {
  try {
    return (boundLeft ? readBoundedFile(leftFile).bytes : fs.readFileSync(leftFile)).equals(fs.readFileSync(rightFile));
  } catch (error) {
    if (error instanceof SnapshotLimitError) (error as Error).message = `${path.basename(leftFile)}: ${(error as Error).message}`;
    throw error;
  }
};

const snapshotIsEmpty = (filePath: string, bound = false): boolean => (
  (bound ? readBoundedFile(filePath).bytes.toString('utf8') : fs.readFileSync(filePath, 'utf8')) === emptySnapshotContent
);

const classifySnapshotResult = (
  isNew: boolean,
  isChanged: boolean,
  isEmpty: boolean,
  wasEmpty: boolean,
): SnapshotResultState => {
  if (!isChanged) {
    return 'unchanged';
  }
  if (isNew || wasEmpty) {
    return 'created';
  }
  if (isEmpty) {
    return 'removed';
  }
  return 'updated';
};

const writeSnapshotStatus = (
  snapshot: SnapshotCommand,
  resultState: SnapshotResultState,
): void => {
  const fileWithoutExtension = snapshot.fileName.replace(/\.[^.]*$/, '');
  if (resultState === 'unchanged') {
    writeStdoutLine(`✔ ${fileWithoutExtension}`);
  } else if (resultState === 'created') {
    writeStdoutLine(terminalEmphasis(`✚ ${fileWithoutExtension}`, 'bold'));
  } else if (resultState === 'removed') {
    writeStdoutLine(terminalEmphasis(`✖︎ ${fileWithoutExtension}`, 'bold'));
  } else {
    writeStdoutLine(terminalEmphasis(`✎ ${fileWithoutExtension}`, 'bold'));
  }
};

const writeSnapshotStatuses = (snapshots: EvaluatedSnapshot[]): void => {
  snapshots
    .toSorted((left, right) => compareBackupFileNames(left.snapshot.fileName, right.snapshot.fileName))
    .forEach(({ snapshot, resultState }) => writeSnapshotStatus(snapshot, resultState));
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? `: ${error.message}` : ''
);

const restrictCacheEntryPermissions = (entryPath: string): void => {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory()) {
    fs.chmodSync(entryPath, 0o700);
    for (const name of fs.readdirSync(entryPath)) {
      restrictCacheEntryPermissions(path.join(entryPath, name));
    }
  } else if (stat.isFile()) {
    fs.chmodSync(entryPath, 0o600);
  } else {
    throw new Error(`unsupported backup cache entry: ${entryPath}`);
  }
};

const secureExistingBackupCache = (cacheDir: string): boolean => {
  try {
    const stat = fs.lstatSync(cacheDir, { throwIfNoEntry: false });
    // Leave creation and non-directory file obstructions to cache promotion.
    if (!stat || stat.isFile()) {
      return true;
    }
    restrictCacheEntryPermissions(cacheDir);
    return true;
  } catch (error) {
    writeStderrLine(`ballin backup: unable to secure backup cache permissions${errorMessage(error)}`);
    return false;
  }
};

const removeStagedSnapshots = (stagedSnapshots: StagedSnapshot[]): boolean => {
  let removed = true;
  stagedSnapshots.forEach(({ localFile }) => {
    try { removeTempFile(localFile); } catch { removed = false; }
  });
  return removed;
};

const captureAvailableSnapshot = (source: AvailableSnapshotObservation, maxBytes?: number): SnapshotCaptureResult => {
  const snapshot = maxBytes === undefined ? source.collector : {
    ...source.collector, args: [...(source.collector.args ?? []), '--max-bytes', String(maxBytes)],
  };
  let inputFile: string | null = null;
  let captured = false;
  try {
    const createdInputFile = makeTempFile('ballin-backup-input-');
    inputFile = createdInputFile;
    if (captureSnapshotInput(snapshot, createdInputFile)) {
      normalizeSnapshotInput(createdInputFile);
      if (maxBytes !== undefined) requireWithinLimit('bytes', fs.statSync(createdInputFile).size, maxBytes);
      captured = true;
    }
  } catch (error) {
    writeStderrLine(`ballin backup: unable to stage ${snapshot.fileName}${errorMessage(error)}`);
  } finally {
    if (!captured && inputFile) {
      try { removeTempFile(inputFile); } catch { reportTemporaryCleanupFailure(); }
    }
  }

  if (!captured || !inputFile) {
    writeStderrLine(`ballin backup: failed to snapshot ${snapshot.fileName}`);
    return { status: 'collector-failed' };
  }
  return { status: 'captured', localFile: inputFile };
};

const stageSnapshots = (observations: SnapshotSourceObservation[]): StagedSnapshot[] | null => {
  const failure = observations.find((source) => source.status === 'discovery-failed' && (source.reason === 'source-limit-exceeded' || source.definition.category === 'codex'));
  if (failure && failure.status === 'discovery-failed') {
    const diagnostic = failure.reason === 'source-limit-exceeded'
      ? `recursive source exceeds the supported snapshot limits; ${failure.error?.message ?? 'capture limit exceeded'}`
      : 'selected Codex source could not be discovered completely';
    writeStderrLine(`ballin backup: ${failure.definition.name}: ${diagnostic}. No snapshots were published.`);
    return null;
  }
  let codexBytes = 0;
  const collection = collectSnapshotObservations(observations, (source: AvailableSnapshotObservation) => {
    const codex = source.definition.category === 'codex';
    const result = captureAvailableSnapshot(source, codex ? snapshotByteLimit - codexBytes : undefined);
    if (codex && result.status === 'captured') {
      try {
        codexBytes += fs.statSync(result.localFile).size;
        requireWithinLimit('bytes', codexBytes, snapshotByteLimit);
      } catch {
        try { removeTempFile(result.localFile); } catch { reportTemporaryCleanupFailure(); }
        writeStderrLine(`ballin backup: unable to verify the bounded capture for ${source.definition.name}`);
        return { status: 'collector-failed' as const };
      }
    }
    return result;
  });
  const stagedSnapshots = collection.flatMap((result: SnapshotCollectionObservation) => (
    result.status === 'captured'
      ? [{ snapshot: result.source.collector, localFile: result.localFile }]
      : []
  ));

  if (collection.some(({ status }: SnapshotCollectionObservation) => status === 'collector-failed')) {
    if (!removeStagedSnapshots(stagedSnapshots)) reportTemporaryCleanupFailure();
    return null;
  }
  return stagedSnapshots;
};

const removeRemoteSnapshots = (remoteSnapshots: Map<string, RemoteSnapshot>): boolean => {
  let removed = true;
  remoteSnapshots.forEach(({ file }) => {
    if (file) {
      try { removeTempFile(file); } catch { removed = false; }
    }
  });
  return removed;
};

const evaluateSnapshots = (
  cacheDir: string,
  stagedSnapshots: StagedSnapshot[],
  remoteSnapshots: Map<string, RemoteSnapshot>,
): { evaluated: EvaluatedSnapshot[]; conflicts: { fileName: string; reason: string }[] } => {
  const evaluated: EvaluatedSnapshot[] = [];
  const conflicts: { fileName: string; reason: string }[] = [];

  stagedSnapshots.forEach((stagedSnapshot) => {
    const { snapshot, localFile } = stagedSnapshot;
    const cacheFile = path.join(cacheDir, snapshot.fileName);
    const baseExists = fileExists(cacheFile);
    const remote = remoteSnapshots.get(snapshot.fileName);
    if (!remote) {
      throw new Error(`missing staged remote state for ${snapshot.fileName}`);
    }

    const localMatchesRemote = remote.exists
      && remote.file !== null
      && snapshotFilesMatch(localFile, remote.file, codexSnapshotFileNames.has(snapshot.fileName));
    let shouldUpload = false;

    if (!baseExists && !remote.exists) {
      shouldUpload = true;
    } else if (!baseExists && remote.exists) {
      if (!localMatchesRemote) {
        conflicts.push({
          fileName: snapshot.fileName,
          reason: 'remote content differs and this machine has no cached base',
        });
        return;
      }
    } else if (baseExists && !remote.exists) {
      conflicts.push({
        fileName: snapshot.fileName,
        reason: 'the remote file is missing but this machine has a cached base',
      });
      return;
    } else if (remote.file !== null) {
      const baseMatchesRemote = snapshotFilesMatch(cacheFile, remote.file, codexSnapshotFileNames.has(snapshot.fileName));
      if (baseMatchesRemote && !localMatchesRemote) {
        shouldUpload = true;
      } else if (!baseMatchesRemote && !localMatchesRemote) {
        conflicts.push({
          fileName: snapshot.fileName,
          reason: 'remote content diverged from the cached base and staged local content',
        });
        return;
      }
    }

    const isEmpty = snapshotIsEmpty(localFile, codexSnapshotFileNames.has(snapshot.fileName));
    const wasEmpty = remote.exists && remote.file !== null && snapshotIsEmpty(remote.file);
    evaluated.push({
      ...stagedSnapshot,
      cacheFile,
      cacheNeedsPromotion: !baseExists || !snapshotFilesMatch(cacheFile, localFile, codexSnapshotFileNames.has(snapshot.fileName)),
      resultState: classifySnapshotResult(!remote.exists, shouldUpload, isEmpty, wasEmpty),
      shouldUpload,
    });
  });

  return { evaluated, conflicts };
};

const reportConflicts = (conflicts: { fileName: string; reason: string }[], destination = 'repository'): void => {
  conflicts.forEach(({ fileName, reason }) => {
    writeStderrLine(`ballin backup: conflict for ${fileName}: ${reason}`);
  });
  writeStderrLine(`ballin backup: conflicts detected; Ballin changed neither the ${destination} nor the backup cache contents`);
  writeStderrLine(`ballin backup: inspect each remote snapshot with 'ballin backup read <file>' or the ${destination} UI`);
  writeStderrLine('ballin backup: reconcile local and remote content so they match, then rerun ballin backup');
};

const promoteCaches = (cacheDir: string, snapshots: EvaluatedSnapshot[]): boolean => {
  const cacheUpdates = snapshots.filter(({ cacheNeedsPromotion }) => cacheNeedsPromotion);
  if (cacheUpdates.length === 0) {
    return true;
  }

  let stagingDir: string;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(cacheDir, 0o700);
    stagingDir = fs.mkdtempSync(path.join(cacheDir, '.ballin-backup-cache-'));
  } catch (error) {
    writeStderrLine(`ballin backup: failed to prepare backup cache updates${errorMessage(error)}`);
    return false;
  }

  try {
    for (const { snapshot, localFile } of cacheUpdates) {
      try {
        const stagedFile = path.join(stagingDir, snapshot.fileName);
        fs.copyFileSync(localFile, stagedFile);
        fs.chmodSync(stagedFile, 0o600);
      } catch (error) {
        writeStderrLine(`ballin backup: failed to stage cache update for ${snapshot.fileName}${errorMessage(error)}`);
        return false;
      }
    }

    let failed = false;
    cacheUpdates.forEach(({ snapshot, cacheFile }) => {
      try {
        fs.renameSync(path.join(stagingDir, snapshot.fileName), cacheFile);
      } catch (error) {
        writeStderrLine(`ballin backup: failed to promote cache for ${snapshot.fileName}${errorMessage(error)}`);
        failed = true;
      }
    });
    return !failed;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
};

const runRepositoryBackup = (
  destination: RepositoryDestination, includeSensitive: boolean, homeDir: string, cacheRoot: string,
): boolean => {
  const staged = stageSnapshots(observeSnapshotSources({ homeDir, env: process.env }, includeSensitive));
  if (!staged) return false;
  const remote = new Map<string, RemoteSnapshot>();
  let completed: EvaluatedSnapshot[] | undefined;
  let publishedCommitUrl: string | undefined;
  try {
    const read: RepositoryRead = requireRepositoryRead(inspectRepository(destination));
    const unexpected = unexpectedRepositoryEntries(read);
    if (unexpected) writeStderrLine(`ballin backup: retaining ${unexpected} unexpected repository entries`);
    for (const { snapshot } of staged) {
      const bytes = read.snapshots.get(snapshot.fileName);
      if (bytes === undefined) remote.set(snapshot.fileName, { exists: false, file: null });
      else {
        const file = makeTempFile('ballin-backup-remote-');
        remote.set(snapshot.fileName, { exists: true, file });
        fs.writeFileSync(file, bytes, { mode: 0o600 });
      }
    }
    const cacheDir = repositoryCacheDirectory(cacheRoot, destination);
    const evaluation = evaluateSnapshots(cacheDir, staged, remote);
    if (evaluation.conflicts.length) { reportConflicts(evaluation.conflicts, 'repository'); return false; }
    const changed = evaluation.evaluated.filter(({ shouldUpload }) => shouldUpload);
    let stagedCodexBytes = 0;
    for (const { snapshot, localFile } of staged) {
      if (codexSnapshotFileNames.has(snapshot.fileName)) {
        stagedCodexBytes += fs.statSync(localFile).size;
        requireWithinLimit('bytes', stagedCodexBytes, snapshotByteLimit);
      }
    }
    const changes = new Map<string, Buffer>();
    let changedCodexBytes = 0;
    let encodedCodexBytes = 0;
    for (const { snapshot, localFile } of changed) {
      const codex = codexSnapshotFileNames.has(snapshot.fileName);
      const bytes = codex ? readBoundedFile(localFile, snapshotByteLimit - changedCodexBytes).bytes : fs.readFileSync(localFile);
      if (codex) {
        changedCodexBytes += bytes.length;
        encodedCodexBytes += 4 * Math.ceil(bytes.length / 3);
      }
      changes.set(snapshot.fileName, bytes);
    }
    // The wire allowance is derived from the stored-byte cap, not another 16 MiB cap.
    requireWithinLimit('bytes', encodedCodexBytes,
      4 * Math.ceil(snapshotByteLimit / 3) + 4 * (codexSnapshotFileNames.size - 1));
    const published = publishRepositorySnapshots(read, changes);
    if (changes.size) publishedCommitUrl = published.commitUrl;
    let promoted = false;
    try { promoted = promoteCaches(cacheDir, evaluation.evaluated); } catch {
      writeStderrLine('ballin backup: unable to finish private cache staging cleanup');
    }
    if (!promoted) {
      writeStderrLine(changes.size
        ? 'ballin backup: repository publication confirmed, but local cache promotion is incomplete'
        : 'ballin backup: repository state confirmed unchanged, but local cache promotion is incomplete');
      writeStderrLine('ballin backup: rerun to re-read and reconcile; no normal success was recorded');
      return false;
    }
    completed = evaluation.evaluated;
  } catch (error) {
    if (error instanceof SnapshotLimitError) {
      writeStderrLine(`ballin backup: ${(error as Error).message} Repository and cache contents were not changed.`);
      return false;
    }
    const problem = (error as RepositoryError).problem;
    writeStderrLine(`ballin backup: ${repositoryMessages[problem] ?? 'Unable to reconcile local backup files.'}`);
    return false;
  } finally {
    const remoteRemoved = removeRemoteSnapshots(remote);
    const stagedRemoved = removeStagedSnapshots(staged);
    if (!remoteRemoved || !stagedRemoved) {
      writeStderrLine('ballin backup: private temporary-file cleanup is incomplete; completed remote and cache effects are retained');
      completed = undefined;
    }
  }
  if (!completed) return false;
  writeSnapshotStatuses(completed);
  if (publishedCommitUrl) writeStdoutLine(`View changes: ${publishedCommitUrl}`);
  return true;
};

const runRealBackup = (homeDir: string, backupCacheDir: string): number => {
  const { config, exitStatus } = backupConfig();
  if (!config) return exitStatus;

  if (!homeDir) {
    writeStderrLine('ballin backup: HOME is not set; unable to collect backup sources safely');
    return 1;
  }

  if (config.includeSensitive === null) {
    writeStderrLine('ballin backup: invalid backup.includeSensitive; expected true or false');
    return 1;
  }
  if (!secureExistingBackupCache(backupCacheDir)) return 1;
  try {
    return runRepositoryBackup(config.repository, config.includeSensitive, homeDir, backupCacheDir) ? 0 : 1;
  } catch (error) {
    writeStderrLine(`ballin backup: ${repositoryMessages[(error as RepositoryError).problem] ?? 'Unable to read backup state.'}`);
    return 1;
  }
};

function runBackupCommand(args = process.argv.slice(2)): void {
  const homeDir = process.env.HOME ?? '';
  const repoDir = process.env.BALLIN_TEST_REPO_DIR || path.join(__dirname, '..');
  const backupCacheDir = path.join(repoDir, '.backup-cache');
  const requestedCommand = args[0];

  if (requestedCommand === 'help') {
    writeStderrLine('ballin backup help: expected no arguments');
    process.exitCode = 1;
    return;
  }

  if (requestedCommand !== undefined && requestedCommand !== '' && !isBackupCommandName(requestedCommand)) {
    writeStderrLine(`ballin backup: unknown command '${requestedCommand}'`);
    process.exitCode = 1;
    return;
  }

  const command = requestedCommand || undefined;

  if (command === 'open' && args.length !== 1) {
    writeStderrLine('ballin backup open: expected no arguments');
    process.exitCode = 1;
    return;
  }

  if (command === 'setup') {
    if (args.length > 2) {
      writeStderrLine('ballin backup setup: expected at most one repository name');
      process.exitCode = 1;
      return;
    }

    const originalConfig = readOriginalSetupConfig(configPath);
    if (!originalConfig) {
      writeStderrLine('ballin backup setup: unable to inspect config');
      process.exitCode = 1;
      return;
    }
    const configExisted = fs.existsSync(configPath);
    if (!configure(repoDir, backupSetupDocsUrl, configPath, true)) {
      writeStderrLine('ballin backup setup: unable to create or update config');
      process.exitCode = 1;
      return;
    }
    if (!configExisted) writeStdoutLine();
    const configured = configureBackup(repoDir, backupSetupDocsUrl, {
      backupCacheDir,
      configPath,
      originalConfig,
      repositoryName: args[1],
    });
    if (!configured) {
      writeStderrLine("ballin backup setup: setup did not complete; resolve the error and retry with 'ballin backup setup'");
    }
    process.exitCode = configured ? 0 : 1;
    return;
  }

  if (command === 'disconnect') {
    if (args.length !== 1) {
      writeStderrLine('ballin backup disconnect: expected no arguments');
      process.exitCode = 1;
    } else process.exitCode = disconnectBackup(configPath, backupCacheDir) ? 0 : 1;
    return;
  }

  if (command === 'read' && !args[1]) {
    process.stdout.write(`Error: 'read' needs a filename.\n\nOptions: ${fileSuggestions}\n`);
    process.exitCode = 1;
    return;
  }

  if (command === 'read' && args.length !== 2) {
    writeStderrLine('ballin backup read: expected exactly one filename');
    process.exitCode = 1;
    return;
  }

  if (!command) {
    let status: 'success' | 'failure' = 'failure';
    try {
      const exitStatus = withTemporaryStatus('Backing up...', () => runRealBackup(homeDir, backupCacheDir));
      status = exitStatus === 0 ? 'success' : 'failure';
      if (exitStatus !== 0) process.exitCode = exitStatus;
    } finally {
      try {
        void recordBehavioralAnalyticsEvent({ event: 'backup.run', status });
      } catch {
        // Analytics must not replace the operation's result or original error.
      }
    }
    return;
  }

  const { config, exitStatus } = backupConfig();
  if (!config) {
    process.exitCode = exitStatus;
    return;
  }

  try {
    if (command === 'read') {
      const bytes = readRepositorySnapshot(config.repository, args[1]);
      if (suggestionFileNames.includes(args[1]) && bytes !== undefined) process.stdout.write(bytes);
      else { writeStdoutLine(`No supported snapshot found.\nOptions: ${fileSuggestions}`); process.exitCode = 1; }
    } else if (command === 'open') {
      const url = repositoryOpenUrl(config.repository);
      writeStdoutLine(`Opening ${url} in your browser.`);
      const result = runCommand('gh', ['browse', '--repo', url], { env: { ...process.env, GH_HOST: 'github.com' }, stdio: 'ignore' });
      process.exitCode = result.error ? 1 : spawnResultStatus(result);
    } else {
      /* c8 ignore next 3 -- The catalog predicate and handled cases enforce the supported command union. */
      const unhandledCommand: never = command;
      throw new Error(`Unhandled backup command: ${String(unhandledCommand)}`);
    }
  } catch (error) {
    writeStderrLine(`ballin backup: ${repositoryMessages[(error as RepositoryError).problem] ?? 'Unable to read backup state.'}`);
    process.exitCode = 1;
  }
}

module.exports = {
  runBackupCommand,
};
