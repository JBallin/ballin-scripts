const fs = require('fs');
const os = require('os');
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
} = require('./install_setup.ts');
const {
  commandExists,
  ensureDir,
  makeTempFile,
  readCommandOutput,
  removeTempFile,
  runCommand,
  writeStderrLine,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const commandPermissionDeniedStatus = 126;
const commandNotFoundStatus = 127;

type SnapshotCommand = {
  fileName: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  suppressStderrOnSuccess?: boolean;
};

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

type SnapshotOptions = Pick<SnapshotCommand, 'env' | 'suppressStderrOnSuccess'>;

type BackupConfigResult = {
  config: { id: string; host: string } | null;
  exitStatus: number;
};

type CommandCheckResult = {
  ok: boolean;
  exitStatus: number;
};

type SnapshotCollector = {
  addFile: (sourceName: string, fileName: string) => void;
  addShellCommand: (
    fileName: string,
    command: string,
    cwd?: string,
    options?: SnapshotOptions,
  ) => void;
  addDirectoryListing: (fileName: string, directory: string) => void;
  snapshots: SnapshotCommand[];
};

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
};

const emptySnapshotContent = 'empty\n';
const configSnapshotFileName = 'ballin_config';
const backupSetupDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';

const fileSuggestions = `
  ${configSnapshotFileName}
  bash_completions
  bash_profile.sh
  bashrc.sh
  Brewfile
  brew_cask
  brew_leaves
  brew_list
  brew_services
  gitconfig
  gitignore_global
  mas
  nanorc
  npm_global
  nvmrc
  pipx
  profile.sh
  pyenv_versions
  uv_tools
  vimrc
  vs_extensions
  vs_keybindings
  vs_settings
  vsI_extensions
  vsI_keybindings
  vsI_settings
  zprofile.sh
  zshrc.sh`;

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

const reportSpawnError = (command: string, error: Error): number => {
  const errorCode = (error as { code?: string }).code;
  if (errorCode === 'EACCES') {
    writeStderrLine(`${command}: Permission denied`);
    return commandPermissionDeniedStatus;
  }
  if (errorCode === 'ENOENT') {
    writeStderrLine(`${command}: command not found`);
    return commandNotFoundStatus;
  }
  writeStderrLine(error.message);
  return 1;
};

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

const shellStyleExitStatus = (result: ReturnType<typeof runCommand>): number => {
  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    if (typeof signalNumber === 'number') {
      return 128 + signalNumber;
    }
  }
  return result.status ?? 1;
};

const fileExists = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const dirExists = (directory: string): boolean => {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
};

const ensureTrailingNewline = (filePath: string): void => {
  const content = fs.readFileSync(filePath);
  if (content.length === 0 || content.at(-1) !== 10) {
    fs.appendFileSync(filePath, '\n');
  }
};

const writeFileToStderr = (filePath: string): void => {
  if (fs.statSync(filePath).size > 0) {
    process.stderr.write(fs.readFileSync(filePath));
  }
};

const ghAuthStatus = (host: string): CommandCheckResult => {
  const result = runCommand('gh', ['auth', 'status', '--hostname', host], {
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
    return { ok: false, exitStatus: shellStyleExitStatus(result) };
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
    return { ok: false, exitStatus: shellStyleExitStatus(result) };
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

const normalizeSnapshotInput = (inputFile: string): void => {
  if (fs.statSync(inputFile).size === 0) {
    fs.writeFileSync(inputFile, emptySnapshotContent);
  } else {
    ensureTrailingNewline(inputFile);
  }
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

const removeStagedSnapshots = (stagedSnapshots: StagedSnapshot[]): void => {
  stagedSnapshots.forEach(({ localFile }) => removeTempFile(localFile));
};

const stageSnapshots = (snapshots: SnapshotCommand[]): StagedSnapshot[] | null => {
  const stagedSnapshots: StagedSnapshot[] = [];
  let failed = false;

  snapshots.forEach((snapshot) => {
    let inputFile: string | null = null;
    let staged = false;
    try {
      const createdInputFile = makeTempFile('ballin-backup-input-');
      inputFile = createdInputFile;
      if (captureSnapshotInput(snapshot, createdInputFile)) {
        normalizeSnapshotInput(createdInputFile);
        stagedSnapshots.push({ snapshot, localFile: createdInputFile });
        staged = true;
      }
    } catch (error) {
      writeStderrLine(`ballin backup: unable to stage ${snapshot.fileName}${errorMessage(error)}`);
    } finally {
      if (!staged && inputFile) {
        removeTempFile(inputFile);
      }
    }

    if (!staged) {
      writeStderrLine(`ballin backup: failed to snapshot ${snapshot.fileName}`);
      failed = true;
    }
  });

  if (failed) {
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
  writeStderrLine('ballin backup: conflicts detected; Ballin changed neither the Gist nor the backup cache');
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
      'ballin backup: the Gist update failed or its outcome is unknown; backup caches were left unchanged',
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
    ensureDir(cacheDir);
    stagingDir = fs.mkdtempSync(path.join(cacheDir, '.ballin-backup-cache-'));
  } catch (error) {
    writeStderrLine(`ballin backup: failed to prepare backup cache updates${errorMessage(error)}`);
    return false;
  }

  try {
    for (const { snapshot, localFile } of cacheUpdates) {
      try {
        fs.copyFileSync(localFile, path.join(stagingDir, snapshot.fileName));
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

const catSnapshot = (homeDir: string, fileName: string, sourcePath: string): SnapshotCommand => ({
  fileName,
  command: 'cat',
  args: [sourcePath],
  cwd: homeDir,
});

const shellSnapshot = (
  fileName: string,
  command: string,
  cwd: string,
): SnapshotCommand => ({
  fileName,
  command: 'bash',
  args: ['-c', command],
  cwd,
});

const directoryListingSnapshot = (fileName: string, directory: string): SnapshotCommand => ({
  fileName,
  command: 'ls',
  args: [directory],
});

const createSnapshotCollector = (homeDir: string): SnapshotCollector => {
  const snapshots: SnapshotCommand[] = [];
  const addFile = (sourceName: string, fileName: string): void => {
    if (fileExists(path.join(homeDir, sourceName))) {
      snapshots.push(catSnapshot(homeDir, fileName, sourceName));
    }
  };
  const addShellCommand = (
    fileName: string,
    command: string,
    cwd = homeDir,
    options: SnapshotOptions = {},
  ): void => {
    snapshots.push({ ...shellSnapshot(fileName, command, cwd), ...options });
  };
  const addDirectoryListing = (fileName: string, directory: string): void => {
    if (dirExists(directory)) {
      snapshots.push(directoryListingSnapshot(fileName, directory));
    }
  };

  return {
    addFile,
    addShellCommand,
    addDirectoryListing,
    snapshots,
  };
};

const collectSnapshots = (homeDir: string): SnapshotCommand[] => {
  const collector = createSnapshotCollector(homeDir);
  const { addFile, addShellCommand, addDirectoryListing, snapshots } = collector;

  addFile('.bash_profile', 'bash_profile.sh');
  addFile('.bashrc', 'bashrc.sh');
  addFile('.profile', 'profile.sh');
  addFile('.zprofile', 'zprofile.sh');
  addFile('.zshrc', 'zshrc.sh');

  const brewAvailable = commandExists('brew');
  let bashCompletionDir = process.env.BALLIN_BACKUP_BASH_COMPLETION_DIR ?? '';
  if (!bashCompletionDir && brewAvailable) {
    const brewPrefix = readCommandOutput('brew', ['--prefix'], {
      env: {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      },
    })?.trim();
    if (brewPrefix) {
      bashCompletionDir = path.join(brewPrefix, 'etc', 'bash_completion.d');
    }
  }
  if (bashCompletionDir && dirExists(bashCompletionDir)) {
    addDirectoryListing('bash_completions', bashCompletionDir);
  }

  if (brewAvailable) {
    const brewEnv = {
      ...process.env,
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
    };
    addShellCommand('brew_list', 'brew list --formula', homeDir, { env: brewEnv });
    addShellCommand('brew_leaves', 'brew leaves', homeDir, { env: brewEnv });
    addShellCommand('brew_cask', 'brew list --cask', homeDir, { env: brewEnv });
    addShellCommand('brew_services', 'brew services list', homeDir, {
      env: brewEnv,
      suppressStderrOnSuccess: true,
    });
    addShellCommand('Brewfile', 'brew bundle dump --file=-', homeDir, { env: brewEnv });
  }

  addFile('.gitignore_global', 'gitignore_global');
  addFile('.gitconfig', 'gitconfig');

  if (commandExists('npm')) {
    addShellCommand('npm_global', 'npm list -g --depth=0');
  }

  if (commandExists('pipx')) {
    addShellCommand('pipx', 'pipx list --json', homeDir, {
      env: {
        ...process.env,
        PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE: '1',
      },
      suppressStderrOnSuccess: true,
    });
  }

  if (commandExists('uv')) {
    addShellCommand(
      'uv_tools',
      'uv tool list --show-version-specifiers --show-with --show-extras --no-progress --color never --no-config',
      homeDir,
      { suppressStderrOnSuccess: true },
    );
  }

  if (commandExists('pyenv')) {
    addShellCommand('pyenv_versions', 'pyenv versions --bare');
  }

  addFile('.nvmrc', 'nvmrc');

  [
    ['Code', 'code', 'vs'],
    ['Code - Insiders', 'code-insiders', 'vsI'],
  ].forEach(([appName, binaryName, prefix]) => {
    const vscodeDir = path.join(homeDir, 'Library', 'Application Support', appName, 'User');
    if (!dirExists(vscodeDir)) {
      return;
    }
    ['settings.json', 'keybindings.json'].forEach((fileName) => {
      if (fileExists(path.join(vscodeDir, fileName))) {
        snapshots.push(catSnapshot(vscodeDir, `${prefix}_${fileName.replace('.json', '')}`, fileName));
      }
    });
    if (commandExists(binaryName)) {
      addShellCommand(`${prefix}_extensions`, `${binaryName} --list-extensions`, vscodeDir);
    }
  });

  addFile('.vimrc', 'vimrc');
  addFile('.nanorc', 'nanorc');
  addFile(path.join('.ballin-scripts', 'ballin.config.json'), configSnapshotFileName);

  if (commandExists('mas')) {
    addShellCommand('mas', 'mas list');
  }

  return snapshots;
};

const runStagedBackup = (
  host: string,
  id: string,
  homeDir: string,
  backupCacheDir: string,
): boolean => {
  const stagedSnapshots = stageSnapshots(collectSnapshots(homeDir));
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

    const backupHostExisted = configHasBackupHost(repoDir, configPath);
    if (!configure(repoDir, backupSetupDocsUrl, configPath)) {
      writeStderrLine('ballin backup setup: unable to create or update config');
      process.exitCode = 1;
      return;
    }
    const configured = configureGist(repoDir, backupSetupDocsUrl, backupHostExisted, {
      backupCacheDir,
      configPath,
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
      process.exitCode = shellStyleExitStatus(result);
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
