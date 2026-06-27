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

const configValue = (key: string): string => (
  readCommandOutput('ballin_config', ['get', key], { stdio: ['ignore', 'pipe', 'inherit'] })?.trim() ?? ''
);

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
  const outputFd = fs.openSync(cacheFile, 'w');
  let result: ReturnType<typeof runCommand>;
  try {
    result = runGist(['-r', id, fileName], { stdio: ['ignore', outputFd, 'inherit'] });
  } finally {
    fs.closeSync(outputFd);
  }
  if (result.error) {
    reportSpawnError('gist', result.error);
  }
  if (result.status === 0 && !result.error) {
    return true;
  }
  fs.rmSync(cacheFile, { force: true });
  return false;
};

const updateSnapshot = (id: string, cacheDir: string, snapshot: SnapshotCommand): boolean => {
  const cacheFile = path.join(cacheDir, snapshot.fileName);
  let isNew = false;
  let isChanged = true;
  let isEmpty = false;

  if (!fileExists(cacheFile)) {
    isNew = !seedCacheFromGist(id, snapshot.fileName, cacheFile);
  }

  const inputFile = makeTempFile('ballin-gu-input-');
  try {
    if (!captureSnapshotInput(snapshot, inputFile)) {
      return false;
    }

    if (fs.statSync(inputFile).size === 0) {
      fs.writeFileSync(inputFile, 'empty\n');
    } else {
      ensureTrailingNewline(inputFile);
    }

    if (!isNew && fileExists(cacheFile)) {
      isChanged = !fs.readFileSync(inputFile).equals(fs.readFileSync(cacheFile));
    }

    if (isChanged) {
      fs.copyFileSync(inputFile, cacheFile);
    }
    isEmpty = fs.readFileSync(cacheFile, 'utf8') === 'empty\n';
  } finally {
    removeTempFile(inputFile);
  }

  if (isChanged) {
    const result = runGist(['-u', id, cacheFile], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (result.error) {
      reportSpawnError('gist', result.error);
    }
  }

  const fileWithoutExtension = snapshot.fileName.replace(/\.[^.]*$/, '');
  if (!isChanged) {
    if (!isEmpty) {
      writeStdoutLine(`✔ ${fileWithoutExtension}`);
    }
  } else if (isNew) {
    writeStdoutLine(`💾 ${fileWithoutExtension}`);
  } else if (isEmpty) {
    writeStdoutLine(`✖︎ ${fileWithoutExtension}`);
  } else {
    writeStdoutLine(`✚ ${fileWithoutExtension}`);
  }

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

const collectSnapshots = (homeDir: string): SnapshotCommand[] => {
  const snapshots: SnapshotCommand[] = [];
  const addIfFile = (sourceName: string, fileName: string): void => {
    if (fileExists(path.join(homeDir, sourceName))) {
      snapshots.push(catSnapshot(homeDir, fileName, sourceName));
    }
  };

  addIfFile('.bash_profile', 'bash_profile.sh');
  addIfFile('.bashrc', 'bashrc.sh');
  addIfFile('.profile', 'profile.sh');
  addIfFile('.zprofile', 'zprofile.sh');
  addIfFile('.zshrc', 'zshrc.sh');

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
    snapshots.push({
      fileName: 'bash_completions',
      command: 'ls',
      args: [bashCompletionDir],
    });
  }

  if (brewAvailable) {
    const brewEnv = {
      ...process.env,
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
    };
    snapshots.push({ ...shellSnapshot('brew_list', 'brew list --formula', homeDir), env: brewEnv });
    snapshots.push({ ...shellSnapshot('brew_leaves', 'brew leaves', homeDir), env: brewEnv });
    snapshots.push({ ...shellSnapshot('brew_cask', 'brew list --cask', homeDir), env: brewEnv });
    snapshots.push({
      ...shellSnapshot('brew_services', 'brew services list', homeDir),
      env: brewEnv,
      suppressStderrOnSuccess: true,
    });
    snapshots.push({ ...shellSnapshot('Brewfile', 'brew bundle dump --file=-', homeDir), env: brewEnv });
  }

  addIfFile('.gitignore_global', 'gitignore_global');
  addIfFile('.gitconfig', 'gitconfig');

  if (commandExists('npm')) {
    snapshots.push(shellSnapshot('npm_global', 'npm list -g --depth=0', homeDir));
  }

  addIfFile('.nvmrc', 'nvmrc');

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
      snapshots.push(shellSnapshot(`${prefix}_extensions`, `${binaryName} --list-extensions`, vscodeDir));
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
    snapshots.push(shellSnapshot('brackets_extensions', 'ls -A extensions/user/', bracketsDir));
    snapshots.push(shellSnapshot('brackets_disabled_extensions', 'ls -A extensions/disabled/', bracketsDir));
  }

  addIfFile('.vimrc', 'vimrc');
  addIfFile('.nanorc', 'nanorc');
  addIfFile(path.join('.ballin-scripts', 'ballin.config.json'), 'ballin_config');

  if (commandExists('mas')) {
    snapshots.push(shellSnapshot('mas', 'mas list', homeDir));
  }

  return snapshots;
};

const runGuCli = (args = process.argv.slice(2)): void => {
  const homeDir = process.env.HOME ?? '';
  const id = configValue('gu.id');
  const url = `${configValue('gu.url')}/${id}`;

  const initialGistRead = runGist(['-r', id], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (initialGistRead.error) {
    reportSpawnError('gist', initialGistRead.error);
  }
  if (initialGistRead.status !== 0 || initialGistRead.error) {
    writeStdoutLine("Error retrieving your gist, please run 'ballin_update'.");
    return;
  }

  if (args.length > 0) {
    if (args[0] === 'open') {
      writeStdoutLine(url);
      process.exitCode = runVisible('open', [url]);
    } else if (args[0] === 'read') {
      if (args[1]) {
        const result = runGist(['-r', id, args[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (result.error) {
          reportSpawnError('gist', result.error);
        }
        if (result.status === 0) {
          return;
        } else {
          process.stdout.write(`\nOptions: ${fileSuggestions}\n`);
        }
      } else {
        process.stdout.write(`Error: 'read' needs a filename.\n\nOptions: ${fileSuggestions}\n`);
      }
    } else if (args[0] === 'help') {
      process.exitCode = runVisible('ballin');
    }
    return;
  }

  const cacheDir = path.join(homeDir, '.ballin-scripts', '.gu-cache');
  ensureDir(cacheDir);

  let failed = false;
  collectSnapshots(homeDir).forEach((snapshot) => {
    if (!updateSnapshot(id, cacheDir, snapshot)) {
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
