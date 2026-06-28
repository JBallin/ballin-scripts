const fs = require('fs');
const os = require('os');
const path = require('path');
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

type SnapshotCacheState = {
  cacheFile: string;
  isNew: boolean;
};

type SnapshotResultState = 'unchanged' | 'created' | 'removed' | 'updated';

type SnapshotOptions = Pick<SnapshotCommand, 'env' | 'suppressStderrOnSuccess'>;

type ConfigValueResult = {
  value: string;
  spawnStatus?: number;
};

type GuConfigResult = {
  config: { id: string; url: string } | null;
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

const emptySnapshotContent = 'empty\n';

const fileSuggestions = `
  ballin_config
  bash_completions
  bash_profile.sh
  bashrc.sh
  brackets_disabled_extensions
  brackets_extensions
  brackets_keymap.json
  brackets_settings.json
  brew_cask
  brew_leaves
  brew_list
  brew_services
  git_config
  gitconfig.cson
  gitignore_global
  mas
  nanorc
  npm_global
  nvmrc
  profile.sh
  vimrc
  vs_extensions
  vs_keybindings
  vs_settings
  vsI_extensions
  vsI_keybindings
  vsI_settings
  zprofile.sh
  zshrc.sh`;

const runGist = (args: string[], options = {}): ReturnType<typeof runCommand> => (
  runCommand('gist', args, options)
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

const configValue = (key: string): ConfigValueResult => {
  const result = runCommand('ballin_config', ['get', key], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) {
    return {
      value: '',
      spawnStatus: reportSpawnError('ballin_config', result.error),
    };
  }
  if (result.status !== 0) {
    return { value: '' };
  }
  const value = result.stdout.trim();
  return { value: value === 'null' ? '' : value };
};

const guConfig = (): GuConfigResult => {
  const idResult = configValue('gu.id');
  const urlResult = configValue('gu.url');
  const id = idResult.value;
  const url = urlResult.value;

  if (id && url) {
    return { config: { id, url }, exitStatus: 0 };
  }

  if (!id) {
    writeStderrLine('gu: missing config value gu.id');
  }
  if (!url) {
    writeStderrLine('gu: missing config value gu.url');
  }
  return {
    config: null,
    exitStatus: idResult.spawnStatus ?? urlResult.spawnStatus ?? 1,
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

const runVisible = (command: string, args: string[] = []): number => {
  const result = runCommand(command, args, { stdio: 'inherit' });
  if (result.error) {
    return reportSpawnError(command, result.error);
  }
  return shellStyleExitStatus(result);
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

const readGistFileToFile = (
  id: string,
  fileName: string,
  outputFile: string,
  stderr: 'inherit' | 'ignore',
): boolean => {
  const outputFd = fs.openSync(outputFile, 'w');
  let result: ReturnType<typeof runCommand>;
  try {
    result = runGist(['-r', id, fileName], { stdio: ['ignore', outputFd, stderr] });
  } finally {
    fs.closeSync(outputFd);
  }
  if (result.error) {
    reportSpawnError('gist', result.error);
  }
  return result.status === 0 && !result.error;
};

const uploadGistFile = (id: string, filePath: string): boolean => {
  const result = runGist(['-u', id, filePath], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error) {
    reportSpawnError('gist', result.error);
  }
  return result.status === 0 && !result.error;
};

const verifyGistReadable = (id: string): CommandCheckResult => {
  const result = runGist(['-r', id], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error) {
    return {
      ok: false,
      exitStatus: reportSpawnError('gist', result.error),
    };
  }
  if (result.status !== 0) {
    return { ok: false, exitStatus: shellStyleExitStatus(result) };
  }
  return { ok: true, exitStatus: 0 };
};

const readGistFileToStdout = (id: string, fileName: string): boolean => {
  const result = runGist(['-r', id, fileName], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) {
    reportSpawnError('gist', result.error);
  }
  return result.status === 0 && !result.error;
};

const captureSnapshotInput = (snapshot: SnapshotCommand, inputFile: string): boolean => {
  const outputFd = fs.openSync(inputFile, 'w');
  const stderrFile = makeTempFile('ballin-gu-stderr-');
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

const seedCacheFromGist = (id: string, fileName: string, cacheFile: string): boolean => {
  if (readGistFileToFile(id, fileName, cacheFile, 'inherit')) {
    return true;
  }
  fs.rmSync(cacheFile, { force: true });
  return false;
};

const prepareSnapshotCache = (id: string, cacheDir: string, fileName: string): SnapshotCacheState => {
  const cacheFile = path.join(cacheDir, fileName);
  const isNew = !fileExists(cacheFile) && !seedCacheFromGist(id, fileName, cacheFile);
  return { cacheFile, isNew };
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

const createSnapshotUploadFile = (sourceFile: string, fileName: string): string => {
  const tempFile = makeTempFile('ballin-gu-upload-');
  const uploadFile = path.join(path.dirname(tempFile), fileName);
  fs.copyFileSync(sourceFile, uploadFile);
  return uploadFile;
};

const classifySnapshotResult = (
  isNew: boolean,
  isChanged: boolean,
  isEmpty: boolean,
): SnapshotResultState => {
  if (!isChanged) {
    return 'unchanged';
  }
  if (isNew) {
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
    writeStdoutLine(`💾 ${fileWithoutExtension}`);
  } else if (resultState === 'removed') {
    writeStdoutLine(`✖︎ ${fileWithoutExtension}`);
  } else {
    writeStdoutLine(`✚ ${fileWithoutExtension}`);
  }
};

const updateSnapshot = (id: string, cacheDir: string, snapshot: SnapshotCommand): boolean => {
  const { cacheFile, isNew } = prepareSnapshotCache(id, cacheDir, snapshot.fileName);
  let resultState: SnapshotResultState = 'updated';
  let isEmpty = false;

  const inputFile = makeTempFile('ballin-gu-input-');
  try {
    if (!captureSnapshotInput(snapshot, inputFile)) {
      return false;
    }

    normalizeSnapshotInput(inputFile);

    let isChanged = true;
    if (!isNew && fileExists(cacheFile)) {
      isChanged = !snapshotFilesMatch(inputFile, cacheFile);
    }

    isEmpty = snapshotIsEmpty(inputFile);
    resultState = classifySnapshotResult(isNew, isChanged, isEmpty);

    if (isChanged) {
      const uploadFile = createSnapshotUploadFile(inputFile, snapshot.fileName);
      try {
        if (!uploadGistFile(id, uploadFile)) {
          return false;
        }
      } finally {
        removeTempFile(uploadFile);
      }
      fs.copyFileSync(inputFile, cacheFile);
    }
  } finally {
    removeTempFile(inputFile);
  }

  writeSnapshotStatus(snapshot, resultState, isEmpty);

  return true;
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
  let bashCompletionDir = process.env.BALLIN_GU_BASH_COMPLETION_DIR ?? '';
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

  const bracketsDir = path.join(homeDir, 'Library', 'Application Support', 'Brackets');
  if (dirExists(bracketsDir)) {
    if (fileExists(path.join(bracketsDir, 'brackets.json'))) {
      snapshots.push(catSnapshot(bracketsDir, 'brackets_settings.json', 'brackets.json'));
    }
    if (fileExists(path.join(bracketsDir, 'keymap.json'))) {
      snapshots.push(catSnapshot(bracketsDir, 'brackets_keymap.json', 'keymap.json'));
    }
    addShellCommand('brackets_extensions', 'ls -A extensions/user/', bracketsDir);
    addShellCommand('brackets_disabled_extensions', 'ls -A extensions/disabled/', bracketsDir);
  }

  addFile('.vimrc', 'vimrc');
  addFile('.nanorc', 'nanorc');
  addFile(path.join('.ballin-scripts', 'ballin.config.json'), 'ballin_config');

  if (commandExists('mas')) {
    addShellCommand('mas', 'mas list');
  }

  return snapshots;
};

const runGuCli = (args = process.argv.slice(2)): void => {
  const homeDir = process.env.HOME ?? '';
  const command = args[0];

  if (command === 'help') {
    if (args.length !== 1) {
      writeStderrLine('gu help: expected no arguments');
      process.exitCode = 1;
      return;
    }
    process.exitCode = runVisible('ballin');
    return;
  }

  if (command && !['open', 'read'].includes(command)) {
    writeStderrLine(`gu: unknown command '${command}'`);
    process.exitCode = 1;
    return;
  }

  if (command === 'open' && args.length !== 1) {
    writeStderrLine('gu open: expected no arguments');
    process.exitCode = 1;
    return;
  }

  if (command === 'read' && !args[1]) {
    process.stdout.write(`Error: 'read' needs a filename.\n\nOptions: ${fileSuggestions}\n`);
    process.exitCode = 1;
    return;
  }

  if (command === 'read' && args.length !== 2) {
    writeStderrLine('gu read: expected exactly one filename');
    process.exitCode = 1;
    return;
  }

  const { config, exitStatus } = guConfig();
  if (!config) {
    process.exitCode = exitStatus;
    return;
  }
  const url = `${config.url}/${config.id}`;

  if (command === 'open') {
    writeStdoutLine(url);
    process.exitCode = runVisible('open', [url]);
    return;
  }

  const gistReadable = verifyGistReadable(config.id);
  if (!gistReadable.ok) {
    writeStdoutLine("Error retrieving your gist, please run 'ballin_update'.");
    process.exitCode = gistReadable.exitStatus;
    return;
  }

  if (command === 'read') {
    if (readGistFileToStdout(config.id, args[1])) {
      return;
    } else {
      process.stdout.write(`\nOptions: ${fileSuggestions}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const cacheDir = path.join(homeDir, '.ballin-scripts', '.gu-cache');
  ensureDir(cacheDir);

  let failed = false;
  collectSnapshots(homeDir).forEach((snapshot) => {
    if (!updateSnapshot(config.id, cacheDir, snapshot)) {
      writeStderrLine(`gu: failed to snapshot ${snapshot.fileName}`);
      failed = true;
    }
  });

  if (failed) {
    process.exitCode = 1;
  }
};

module.exports = {
  runGuCli,
};
