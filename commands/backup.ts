const fs = require('fs');
const path = require('path');
const {
  configPath,
  fetchConfig,
} = require('../config/index.ts');
const {
  backupDestinationFromConfig,
  isConfigObject,
} = require('./backup_config.ts');
const {
  configure,
  configHasBackupHost,
  configureGist,
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
  emptySnapshotContent,
  normalizeSnapshotInput,
  observeSnapshotSources,
  snapshotDefinitions,
} = require('./backup_snapshots.ts');

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
  isEmpty: boolean;
  resultState: SnapshotResultState;
  shouldUpload: boolean;
};

type GistFileMetadata = {
  content?: unknown;
  size?: unknown;
  truncated?: unknown;
};

type GistMetadata = {
  files: Record<string, GistFileMetadata>;
  truncated?: unknown;
};

type BackupConfigResult = {
  config: { id: string; host: string } | null;
  exitStatus: number;
};

type CommandCheckResult = {
  ok: boolean;
  exitStatus: number;
};

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
};

const backupSetupDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';

const suggestionSortKey = (fileName: string): string => (
  fileName === 'Brewfile' ? 'brew' : fileName.toLowerCase()
);

const compareSuggestionFileNames = (left: string, right: string): number => {
  const leftKey = suggestionSortKey(left);
  const rightKey = suggestionSortKey(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

const suggestionFileNames = snapshotDefinitions
  .map(({ name }: { name: string }) => name)
  .toSorted(compareSuggestionFileNames);

const fileSuggestions = `\n${suggestionFileNames.map((name: string) => `  ${name}`).join('\n')}`;

const runGh = (
  host: string,
  args: string[],
  options: CommandOptions = {},
): ReturnType<typeof runCommand> => (
  runCommand('gh', args, {
    ...options,
    env: {
      ...process.env,
      ...options.env,
      GH_HOST: host,
    },
  })
);

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

  const { id, host, idStatus } = backupDestinationFromConfig(configObj);

  if (idStatus === 'invalid') {
    writeStderrLine('ballin backup: invalid config value backup.id; expected null or a non-empty string');
    writeStderrLine('ballin backup: run ballin config reset to restore valid defaults, then run ballin backup setup if needed');
    return { config: null, exitStatus: 1 };
  }

  if (id && host) {
    return { config: { id, host }, exitStatus: 0 };
  }

  if (!id) {
    writeStderrLine("ballin backup: backup is not configured; run 'ballin backup setup' to enable it");
    return { config: null, exitStatus: 1 };
  }
  if (!host) {
    writeStderrLine('ballin backup: missing or invalid config value backup.host; run ballin backup setup to repair it');
  }
  return {
    config: null,
    exitStatus: 1,
  };
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
    process.stderr.write(fs.readFileSync(filePath));
  }
};

const ghAuthStatus = (host: string): CommandCheckResult => {
  const result = runGh(host, ['api', '--hostname', host, 'user'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.error) {
    return {
      ok: false,
      exitStatus: reportSpawnError('gh', result.error),
    };
  }
  if (result.status !== 0) {
    writeStderrLine(`ballin backup: GitHub CLI authentication is required for ${host}`);
    writeStderrLine(`ballin backup: run 'gh auth login --hostname ${host}'`);
    return { ok: false, exitStatus: spawnResultStatus(result) };
  }
  return { ok: true, exitStatus: 0 };
};

const readGistFileToFile = (
  host: string,
  id: string,
  fileName: string,
  outputFile: string,
  stderr: 'inherit' | 'ignore',
): boolean => {
  const outputFd = fs.openSync(outputFile, 'w');
  let result: ReturnType<typeof runCommand>;
  try {
    result = runGh(host, ['gist', 'view', id, '--raw', '--filename', fileName], {
      stdio: ['ignore', outputFd, stderr],
    });
  } finally {
    fs.closeSync(outputFd);
  }
  if (result.error) {
    reportSpawnError('gh', result.error);
  }
  return result.status === 0 && !result.error;
};

const readGistMetadata = (host: string, id: string): GistMetadata | null => {
  const metadataFile = makeTempFile('ballin-backup-gist-metadata-');
  const outputFd = fs.openSync(metadataFile, 'w');
  let result: ReturnType<typeof runCommand>;
  try {
    result = runGh(host, [
      'api',
      '--hostname', host,
      '--method', 'GET',
      `gists/${id}`,
    ], { stdio: ['ignore', outputFd, 'inherit'] });
  } finally {
    fs.closeSync(outputFd);
  }

  if (result.error) {
    reportSpawnError('gh', result.error);
    removeTempFile(metadataFile);
    return null;
  }
  if (result.status !== 0) {
    removeTempFile(metadataFile);
    return null;
  }

  try {
    const metadata: unknown = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (
      typeof metadata !== 'object'
      || metadata === null
      || !('files' in metadata)
      || typeof metadata.files !== 'object'
      || metadata.files === null
      || Array.isArray(metadata.files)
    ) {
      writeStderrLine('ballin backup: GitHub returned invalid Gist metadata');
      return null;
    }
    const parsedMetadata = metadata as GistMetadata;
    if (
      parsedMetadata.truncated !== undefined
      && typeof parsedMetadata.truncated !== 'boolean'
    ) {
      writeStderrLine('ballin backup: GitHub returned an invalid Gist truncation marker');
      return null;
    }
    if (parsedMetadata.truncated === true) {
      writeStderrLine('ballin backup: the remote Gist file list was truncated; refusing to infer missing files');
      return null;
    }
    return parsedMetadata;
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : '';
    writeStderrLine(`ballin backup: unable to parse Gist metadata${message}`);
    return null;
  } finally {
    removeTempFile(metadataFile);
  }
};

const verifyGistReadable = (host: string, id: string): CommandCheckResult => {
  const result = runGh(host, ['gist', 'view', id, '--files'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error) {
    return {
      ok: false,
      exitStatus: reportSpawnError('gh', result.error),
    };
  }
  if (result.status !== 0) {
    return { ok: false, exitStatus: spawnResultStatus(result) };
  }
  return { ok: true, exitStatus: 0 };
};

const readGistFileToStdout = (host: string, id: string, fileName: string): boolean => {
  const result = runGh(host, ['gist', 'view', id, '--raw', '--filename', fileName], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    reportSpawnError('gh', result.error);
  }
  return result.status === 0 && !result.error;
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
  removeTempFile(stderrFile);
  if (result.error) {
    reportSpawnError(snapshot.command, result.error);
  }

  return result.status === 0 && !result.error;
};

const snapshotFilesMatch = (leftFile: string, rightFile: string): boolean => (
  fs.readFileSync(leftFile).equals(fs.readFileSync(rightFile))
);

const snapshotIsEmpty = (filePath: string): boolean => (
  fs.readFileSync(filePath, 'utf8') === emptySnapshotContent
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
  isEmpty: boolean,
): void => {
  const fileWithoutExtension = snapshot.fileName.replace(/\.[^.]*$/, '');
  if (resultState === 'unchanged') {
    if (!isEmpty) {
      writeStdoutLine(`✔ ${fileWithoutExtension}`);
    }
  } else if (resultState === 'created') {
    writeStdoutLine(`✚ ${fileWithoutExtension}`);
  } else if (resultState === 'removed') {
    writeStdoutLine(`✖︎ ${fileWithoutExtension}`);
  } else {
    writeStdoutLine(`✎ ${fileWithoutExtension}`);
  }
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

const removeStagedSnapshots = (stagedSnapshots: StagedSnapshot[]): void => {
  stagedSnapshots.forEach(({ localFile }) => removeTempFile(localFile));
};

const captureAvailableSnapshot = (source: AvailableSnapshotObservation): SnapshotCaptureResult => {
  const snapshot = source.collector;
  let inputFile: string | null = null;
  let captured = false;
  try {
    const createdInputFile = makeTempFile('ballin-backup-input-');
    inputFile = createdInputFile;
    if (captureSnapshotInput(snapshot, createdInputFile)) {
      normalizeSnapshotInput(createdInputFile);
      captured = true;
    }
  } catch (error) {
    writeStderrLine(`ballin backup: unable to stage ${snapshot.fileName}${errorMessage(error)}`);
  } finally {
    if (!captured && inputFile) {
      removeTempFile(inputFile);
    }
  }

  if (!captured || !inputFile) {
    writeStderrLine(`ballin backup: failed to snapshot ${snapshot.fileName}`);
    return { status: 'collector-failed' };
  }
  return { status: 'captured', localFile: inputFile };
};

const stageSnapshots = (observations: SnapshotSourceObservation[]): StagedSnapshot[] | null => {
  const collection = collectSnapshotObservations(observations, captureAvailableSnapshot);
  const stagedSnapshots = collection.flatMap((result: SnapshotCollectionObservation) => (
    result.status === 'captured'
      ? [{ snapshot: result.source.collector, localFile: result.localFile }]
      : []
  ));

  if (collection.some(({ status }: SnapshotCollectionObservation) => status === 'collector-failed')) {
    removeStagedSnapshots(stagedSnapshots);
    return null;
  }
  return stagedSnapshots;
};

const removeRemoteSnapshots = (remoteSnapshots: Map<string, RemoteSnapshot>): void => {
  remoteSnapshots.forEach(({ file }) => {
    if (file) {
      removeTempFile(file);
    }
  });
};

const readRemoteSnapshots = (
  host: string,
  id: string,
  stagedSnapshots: StagedSnapshot[],
): Map<string, RemoteSnapshot> | null => {
  const remoteSnapshots = new Map<string, RemoteSnapshot>();
  const metadata = readGistMetadata(host, id);
  if (!metadata) {
    writeStderrLine('ballin backup: failed to read current Gist state');
    return null;
  }

  try {
    for (const { snapshot } of stagedSnapshots) {
      const { fileName } = snapshot;
      if (!Object.prototype.hasOwnProperty.call(metadata.files, fileName)) {
        remoteSnapshots.set(fileName, { exists: false, file: null });
        continue;
      }

      const fileMetadata = metadata.files[fileName];
      if (typeof fileMetadata !== 'object' || fileMetadata === null) {
        writeStderrLine(`ballin backup: invalid remote metadata for ${fileName}`);
        removeRemoteSnapshots(remoteSnapshots);
        return null;
      }
      if (
        fileMetadata.truncated !== undefined
        && typeof fileMetadata.truncated !== 'boolean'
      ) {
        writeStderrLine(`ballin backup: invalid truncation metadata for remote snapshot ${fileName}`);
        removeRemoteSnapshots(remoteSnapshots);
        return null;
      }

      const remoteFile = makeTempFile('ballin-backup-remote-');
      let readSucceeded = false;
      try {
        if (fileMetadata.truncated === true) {
          readSucceeded = readGistFileToFile(host, id, fileName, remoteFile, 'inherit');
        } else if (typeof fileMetadata.content === 'string') {
          fs.writeFileSync(remoteFile, fileMetadata.content);
          readSucceeded = true;
        }

        const expectedSize = fileMetadata.size;
        const hasValidExpectedSize = (
          typeof expectedSize === 'number'
          && Number.isSafeInteger(expectedSize)
          && expectedSize >= 0
        );
        if (!hasValidExpectedSize) {
          writeStderrLine(`ballin backup: missing or invalid size metadata for remote snapshot ${fileName}`);
          readSucceeded = false;
        }
        if (
          readSucceeded
          && fs.statSync(remoteFile).size !== expectedSize
        ) {
          writeStderrLine(`ballin backup: remote snapshot ${fileName} was incomplete or changed while reading`);
          readSucceeded = false;
        }
        if (!readSucceeded) {
          writeStderrLine(`ballin backup: failed to read remote snapshot ${fileName}`);
          removeTempFile(remoteFile);
          removeRemoteSnapshots(remoteSnapshots);
          return null;
        }
      } catch (error) {
        writeStderrLine(`ballin backup: failed to read remote snapshot ${fileName}${errorMessage(error)}`);
        removeTempFile(remoteFile);
        removeRemoteSnapshots(remoteSnapshots);
        return null;
      }

      remoteSnapshots.set(fileName, { exists: true, file: remoteFile });
    }
  } catch (error) {
    writeStderrLine(`ballin backup: failed to read current Gist state${errorMessage(error)}`);
    removeRemoteSnapshots(remoteSnapshots);
    return null;
  }

  return remoteSnapshots;
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
      && snapshotFilesMatch(localFile, remote.file);
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
      const baseMatchesRemote = snapshotFilesMatch(cacheFile, remote.file);
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

    const isEmpty = snapshotIsEmpty(localFile);
    const wasEmpty = remote.exists && remote.file !== null && snapshotIsEmpty(remote.file);
    evaluated.push({
      ...stagedSnapshot,
      cacheFile,
      cacheNeedsPromotion: !baseExists || !snapshotFilesMatch(cacheFile, localFile),
      isEmpty,
      resultState: classifySnapshotResult(!remote.exists, shouldUpload, isEmpty, wasEmpty),
      shouldUpload,
    });
  });

  return { evaluated, conflicts };
};

const reportConflicts = (conflicts: { fileName: string; reason: string }[]): void => {
  conflicts.forEach(({ fileName, reason }) => {
    writeStderrLine(`ballin backup: conflict for ${fileName}: ${reason}`);
  });
  writeStderrLine('ballin backup: conflicts detected; Ballin changed neither the Gist nor the backup cache contents');
  writeStderrLine("ballin backup: inspect each remote snapshot with 'ballin backup read <file>' or the Gist UI");
  writeStderrLine('ballin backup: reconcile local and remote content so they match, then rerun ballin backup');
};

const updateGist = (host: string, id: string, snapshots: EvaluatedSnapshot[]): boolean => {
  const changedSnapshots = snapshots.filter(({ shouldUpload }) => shouldUpload);
  if (changedSnapshots.length === 0) {
    return true;
  }

  const payloadFile = makeTempFile('ballin-backup-payload-');
  try {
    const files = Object.fromEntries(changedSnapshots.map(({ snapshot, localFile }) => [
      snapshot.fileName,
      { content: fs.readFileSync(localFile, 'utf8') },
    ]));
    fs.writeFileSync(payloadFile, JSON.stringify({ files }));

    const result = runGh(host, [
      'api',
      '--hostname', host,
      '--method', 'PATCH',
      `gists/${id}`,
      '--input', payloadFile,
      '--silent',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });

    if (result.error) {
      reportSpawnError('gh', result.error);
    }
    if (result.status === 0 && !result.error && !result.signal) {
      return true;
    }
    writeStderrLine(
      'ballin backup: the Gist update failed or its outcome is unknown; backup cache contents were left unchanged',
    );
    writeStderrLine('ballin backup: rerun ballin backup to re-read and reconcile current remote state');
    return false;
  } catch (error) {
    writeStderrLine(`ballin backup: failed to prepare the Gist update${errorMessage(error)}`);
    return false;
  } finally {
    removeTempFile(payloadFile);
  }
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

const runStagedBackup = (
  host: string,
  id: string,
  homeDir: string,
  backupCacheDir: string,
): boolean => {
  // Gist capture retains its existing sources until #333–#334 activate the
  // shared reviewed policy and retire this destination path.
  const sourceObservations = observeSnapshotSources(
    { homeDir, env: process.env },
    true,
  );
  const stagedSnapshots = stageSnapshots(sourceObservations);
  if (!stagedSnapshots) {
    return false;
  }

  try {
    const remoteSnapshots = readRemoteSnapshots(host, id, stagedSnapshots);
    if (!remoteSnapshots) {
      return false;
    }

    try {
      let evaluation: ReturnType<typeof evaluateSnapshots>;
      try {
        evaluation = evaluateSnapshots(backupCacheDir, stagedSnapshots, remoteSnapshots);
      } catch (error) {
        writeStderrLine(`ballin backup: failed to reconcile staged snapshots${errorMessage(error)}`);
        return false;
      }

      if (evaluation.conflicts.length > 0) {
        reportConflicts(evaluation.conflicts);
        return false;
      }

      if (!updateGist(host, id, evaluation.evaluated)) {
        return false;
      }

      if (!promoteCaches(backupCacheDir, evaluation.evaluated)) {
        writeStderrLine('ballin backup: the Gist outcome is known, but one or more cache updates failed');
        writeStderrLine('ballin backup: rerun ballin backup to re-read and reconcile current remote state');
        return false;
      }

      evaluation.evaluated.forEach(({ snapshot, resultState, isEmpty }) => {
        writeSnapshotStatus(snapshot, resultState, isEmpty);
      });
      return true;
    } finally {
      removeRemoteSnapshots(remoteSnapshots);
    }
  } finally {
    removeStagedSnapshots(stagedSnapshots);
  }
};

function runBackupCommand(args = process.argv.slice(2)): void {
  const homeDir = process.env.HOME ?? '';
  const repoDir = process.env.BALLIN_TEST_REPO_DIR || path.join(__dirname, '..');
  const backupCacheDir = path.join(repoDir, '.backup-cache');
  const command = args[0];

  if (command === 'help') {
    writeStderrLine('ballin backup help: expected no arguments');
    process.exitCode = 1;
    return;
  }

  if (command && !['open', 'read', 'setup'].includes(command)) {
    writeStderrLine(`ballin backup: unknown command '${command}'`);
    process.exitCode = 1;
    return;
  }

  if (command === 'open' && args.length !== 1) {
    writeStderrLine('ballin backup open: expected no arguments');
    process.exitCode = 1;
    return;
  }

  if (command === 'setup') {
    if (args.length !== 1) {
      writeStderrLine('ballin backup setup: expected no arguments');
      process.exitCode = 1;
      return;
    }

    const originalConfig = readOriginalSetupConfig(configPath);
    if (!originalConfig) {
      writeStderrLine('ballin backup setup: unable to inspect config');
      process.exitCode = 1;
      return;
    }
    const backupHostExisted = configHasBackupHost(repoDir, configPath);
    if (!configure(repoDir, backupSetupDocsUrl, configPath)) {
      writeStderrLine('ballin backup setup: unable to create or update config');
      process.exitCode = 1;
      return;
    }
    const configured = configureGist(repoDir, backupSetupDocsUrl, backupHostExisted, {
      backupCacheDir,
      configPath,
      originalConfig,
    });
    if (!configured) {
      writeStderrLine("ballin backup setup: setup did not complete; resolve the error and retry with 'ballin backup setup'");
    }
    process.exitCode = configured ? 0 : 1;
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

  const { config, exitStatus } = backupConfig();
  if (!config) {
    process.exitCode = exitStatus;
    return;
  }

  if (!command && !homeDir) {
    writeStderrLine('ballin backup: HOME is not set; unable to collect backup sources safely');
    process.exitCode = 1;
    return;
  }

  if (!command && !secureExistingBackupCache(backupCacheDir)) {
    process.exitCode = 1;
    return;
  }

  const ghAuthenticated = ghAuthStatus(config.host);
  if (!ghAuthenticated.ok) {
    process.exitCode = ghAuthenticated.exitStatus;
    return;
  }

  if (command === 'open') {
    const result = runGh(config.host, ['gist', 'view', config.id, '--web'], { stdio: 'inherit' });
    if (result.error) {
      process.exitCode = reportSpawnError('gh', result.error);
    } else {
      process.exitCode = spawnResultStatus(result);
    }
    return;
  }

  if (command === 'read') {
    const gistReadable = verifyGistReadable(config.host, config.id);
    if (!gistReadable.ok) {
      writeStdoutLine("Error retrieving your gist, please run 'ballin self-update'.");
      process.exitCode = gistReadable.exitStatus;
      return;
    }
    if (readGistFileToStdout(config.host, config.id, args[1])) {
      return;
    } else {
      process.stdout.write(`\nOptions: ${fileSuggestions}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!runStagedBackup(config.host, config.id, homeDir, backupCacheDir)) {
    process.exitCode = 1;
  }
}

module.exports = {
  runBackupCommand,
};
