const fs = require('fs');
const path = require('path');
const {
  ensureAnalyticsInstallId,
} = require('./analytics.ts');
const {
  commandExists,
  readCommandOutput,
  runCommand,
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

type ConfigObject = { [key: string]: unknown };

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const setupAnalyticsInstallId = (repoDir: string, configPath: string): void => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigObject;
    const analyticsConfig = isConfigObject(config.analytics) ? config.analytics : undefined;
    ensureAnalyticsInstallId({
      analyticsConfig,
      env: process.env,
      repoDir,
      noticeWriter: writeStdoutLine,
    });
  } catch {
    // Analytics setup must never block install or update.
  }
};

const setupAnalytics = (repoDir: string): boolean => {
  setupAnalyticsInstallId(repoDir, path.join(repoDir, 'ballin.config.json'));
  return true;
};

const configPathFor = (repoDir: string): string => path.join(repoDir, 'ballin.config.json');

const commandEnv = (cwd: string, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extraEnv,
  PWD: cwd,
});

const readLineFromStdin = (): string => {
  const input = Buffer.alloc(1);
  let line = '';

  while (true) {
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(0, input, 0, 1, null);
    } catch {
      return line;
    }

    if (bytesRead === 0) {
      return line;
    }

    const character = input.toString('utf8', 0, bytesRead);
    if (character === '\n') {
      return line;
    }
    if (character !== '\r') {
      line += character;
    }
  }
};

const prompt = (message: string): string => {
  process.stdout.write(message);
  return readLineFromStdin();
};

const readJsonObject = (filePath: string): ConfigObject | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isConfigObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const configHasGuHost = (repoDir: string): boolean => {
  const config = readJsonObject(configPathFor(repoDir));
  return isConfigObject(config?.gu) && Object.prototype.hasOwnProperty.call(config.gu, 'host');
};

const updateConfig = (repoDir: string, docsUrl: string): boolean => {
  const updateConfigPath = path.join(repoDir, 'config', 'updateConfig.ts');
  const childEnv = commandEnv(path.join(repoDir, 'config'));
  delete childEnv.BALLIN_TEST_CONFIG_PATH;

  const updateResult = runCommand(process.execPath, [updateConfigPath], {
    cwd: path.join(repoDir, 'config'),
    env: childEnv,
  });

  if (updateResult.stderr) {
    process.stderr.write(updateResult.stderr);
  }

  if (updateResult.status !== 0 || updateResult.error) {
    return false;
  }

  const updateOutput = updateResult.stdout.trimEnd();
  if (updateOutput) {
    writeStdoutLine(`\n🙌 ${updateOutput}`);
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  return true;
};

const configure = (repoDir: string, docsUrl: string): boolean => {
  const configPath = configPathFor(repoDir);
  const defaultConfigPath = path.join(repoDir, 'config', '.defaultConfig.json');

  if (!fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(defaultConfigPath, configPath);
    } catch {
      return false;
    }
    writeStdoutLine("\n🧠 Created 'ballin.config.json' file in root using default settings");
    return true;
  }

  return updateConfig(repoDir, docsUrl);
};

const ballinConfigPath = (repoDir: string): string => path.join(repoDir, 'bin', 'ballin_config');

const runBallinConfigGet = (repoDir: string, key: string): string | null => {
  const result = runCommand(ballinConfigPath(repoDir), ['get', key], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  });

  if (result.status !== 0 || result.error) {
    return null;
  }

  return result.stdout.trimEnd();
};

const runBallinConfigSet = (repoDir: string, key: string, value: string): boolean => (
  runVisibleCommand(ballinConfigPath(repoDir), ['set', key, value], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  }) === 0
);

const runGh = (
  repoDir: string,
  host: string,
  args: string[],
  options: { quiet?: boolean } = {},
) => runCommand('gh', args, {
  cwd: repoDir,
  env: commandEnv(repoDir, { GH_HOST: host }),
  stdio: options.quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
});

const configureGist = (repoDir: string, docsUrl: string, guHostExisted: boolean): boolean => {
  let guHost = runBallinConfigGet(repoDir, 'gu.host');
  const guId = runBallinConfigGet(repoDir, 'gu.id');

  if (guHost === null || guId === null) {
    return false;
  }

  if (process.env.BALLIN_GU_HOST) {
    if (!runBallinConfigSet(repoDir, 'gu.host', process.env.BALLIN_GU_HOST)) {
      return false;
    }
    guHost = runBallinConfigGet(repoDir, 'gu.host');
    if (guHost === null) {
      return false;
    }
  } else if (guId === 'null' || !guHostExisted) {
    writeStdoutLine();
    const inputHost = prompt(`🤔 What GitHub host should be used for Gist backups? [${guHost}] `);
    if (inputHost) {
      if (!runBallinConfigSet(repoDir, 'gu.host', inputHost)) {
        return false;
      }
      guHost = runBallinConfigGet(repoDir, 'gu.host');
      if (guHost === null) {
        return false;
      }
    }
  }

  if (!commandExists('gh')) {
    writeStdoutLine('\n⚠️  ERROR: GitHub CLI is required for Gist backup setup.');
    writeStdoutLine('\nInstall gh, authenticate it, then run this installer again.');
    writeStdoutLine(`\nSetup guide: ${docsUrl}`);
    writeStdoutLine(`\nRun after installing gh:\n  gh auth login --hostname ${guHost}`);
    return false;
  }

  const authResult = runGh(repoDir, guHost, ['auth', 'status', '--hostname', guHost], { quiet: true });
  if (authResult.status !== 0 || authResult.error) {
    writeStdoutLine(`\n⚠️  ERROR: gh is not authenticated for ${guHost}.`);
    writeStdoutLine(`\nRun:\n  gh auth login --hostname ${guHost}`);
    writeStdoutLine('\nThen run this installer again.');
    return false;
  }

  if (guId !== 'null') {
    return true;
  }

  const gistDescription = '### Backup of your dev environment\n'
    + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n';

  writeStdoutLine();
  const hasBackup = prompt('🤔 Do you already have a ballin-scripts backup gist? [y/N] ');
  if (hasBackup === 'y' || hasBackup === 'Y') {
    writeStdoutLine('\nWelcome Back!');
    let validGistId = false;

    while (!validGistId) {
      const gistId = prompt('Enter your gist ID: ');
      const markerResult = runGh(
        repoDir,
        guHost,
        ['gist', 'view', gistId, '--raw', '--filename', '.MyConfig.md'],
        { quiet: true },
      );

      if (markerResult.status === 0 && markerResult.stdout === gistDescription) {
        writeStdoutLine('\n👍 Storing your previous gist ID in your config:');
        const configPath = configPathFor(repoDir);
        const previousConfig = fs.readFileSync(configPath, 'utf8');
        const restoreResult = runGh(
          repoDir,
          guHost,
          ['gist', 'view', gistId, '--raw', '--filename', 'ballin_config'],
          { quiet: true },
        );

        if (restoreResult.status === 0 && !restoreResult.error) {
          fs.writeFileSync(configPath, restoreResult.stdout);
          if (!updateConfig(repoDir, docsUrl)) {
            fs.writeFileSync(configPath, previousConfig);
            return false;
          }
          writeStdoutLine('\n♻️  Restored ballin.config.json from your backup gist.');
        } else {
          writeStdoutLine('\nℹ️  No ballin_config snapshot was found in that gist; keeping the local config defaults.');
        }

        if (!runBallinConfigSet(repoDir, 'gu.id', gistId)) {
          return false;
        }
        validGistId = true;
      } else {
        writeStdoutLine(`\n⚠️  INVALID: Expected backup marker in gist '${gistId}'.`);
      }
    }
  }

  if (runBallinConfigGet(repoDir, 'gu.id') === 'null') {
    const markerPath = path.join(repoDir, '.MyConfig.md');
    fs.writeFileSync(markerPath, gistDescription);

    const createResult = runGh(repoDir, guHost, ['gist', 'create', '.MyConfig.md', '--desc', gistDescription]);
    if (createResult.status !== 0 || createResult.error) {
      fs.rmSync(markerPath, { force: true });
      return false;
    }

    const gistUrl = createResult.stdout.trimEnd();
    writeStdoutLine(`\n💥 Created a secret gist titled '.MyConfig' at the following URL:\n${gistUrl}`);

    const gistId = gistUrl.split('/').pop() ?? gistUrl;
    writeStdoutLine('\n🧳 Storing your new gist ID in your config...');
    if (!runBallinConfigSet(repoDir, 'gu.id', gistId)) {
      fs.rmSync(markerPath, { force: true });
      return false;
    }

    const guCachePath = path.join(repoDir, '.gu-cache');
    if (fs.existsSync(guCachePath)) {
      fs.rmSync(guCachePath, { recursive: true, force: true });
      writeStdoutLine('\n🗑  Deleted existing .gu-cache folder');
    }

    fs.rmSync(markerPath, { force: true });
  }

  return true;
};

const symlinkBinaries = (repoDir: string, binDir: string): boolean => {
  const sourceBinDir = path.join(repoDir, 'bin');

  try {
    fs.mkdirSync(binDir, { recursive: true });
  } catch {
    writeStdoutLine(`\n⚠️  ERROR: Unable to create ${binDir}`);
    return false;
  }

  try {
    for (const binName of fs.readdirSync(sourceBinDir)) {
      const sourcePath = path.join(sourceBinDir, binName);
      const targetPath = path.join(binDir, binName);

      fs.rmSync(targetPath, { force: true });
      fs.symlinkSync(sourcePath, targetPath);
    }
  } catch {
    writeStdoutLine(`\n⚠️  ERROR: Unable to symlink binaries into ${binDir}`);
    return false;
  }

  writeStdoutLine(`\n💪 symlinked binaries into ${binDir}`);
  return true;
};

const resolveBinDir = (): string | null => {
  if (commandExists('brew')) {
    const brewPrefix = readCommandOutput('brew', ['--prefix']);
    if (brewPrefix !== null) {
      return path.join(brewPrefix.trimEnd(), 'bin');
    }
  }

  const homeDir = process.env.HOME;
  return homeDir ? path.join(homeDir, '.local', 'bin') : null;
};

const validateBinDirInPath = (binDir: string): boolean => {
  const envPath = process.env.PATH ?? '';
  if (envPath.split(path.delimiter).includes(binDir)) {
    return true;
  }

  writeStdoutLine(`\n⚠️  ERROR: ${binDir} doesn't seem to be in your path.`);
  writeStdoutLine(`Add 'export PATH="${binDir}:$PATH"' to your shell profile.`);
  writeStdoutLine('and open a new terminal window and run this installation again.');
  return false;
};

const setup = (repoDir: string, docsUrl: string): boolean => {
  const binDir = resolveBinDir();
  if (!binDir || !validateBinDirInPath(binDir)) {
    return false;
  }

  const configExisted = fs.existsSync(configPathFor(repoDir));
  const guHostExisted = configExisted && configHasGuHost(repoDir);

  if (!configure(repoDir, docsUrl)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to create or update ballin.config.json');
    return false;
  }

  if (!configureGist(repoDir, docsUrl, guHostExisted)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to configure Gist backup');
    return false;
  }

  setupAnalytics(repoDir);

  if (!symlinkBinaries(repoDir, binDir)) {
    return false;
  }

  if (!configExisted && fs.existsSync(configPathFor(repoDir))) {
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  writeStdoutLine('\n😎 ballin!');
  return true;
};

const runInstallSetupCli = (): void => {
  const [, , command, repoDir, option] = process.argv;

  if (command === 'configure' && repoDir && option) {
    process.exitCode = configure(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'symlink-binaries' && repoDir && option) {
    process.exitCode = symlinkBinaries(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'setup' && repoDir && option) {
    process.exitCode = setup(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'setup-analytics' && repoDir) {
    process.exitCode = setupAnalytics(repoDir) ? 0 : 1;
    return;
  }

  if (!command || !repoDir || !option) {
    writeStdoutLine('Usage: install_setup.ts <configure|setup|symlink-binaries|setup-analytics> <repo-dir> [docs-url|bin-dir]');
    process.exitCode = 1;
    return;
  }

  writeStdoutLine(`Unknown install setup command: ${command}`);
  process.exitCode = 1;
};

if (require.main === module) {
  runInstallSetupCli();
}

module.exports = {
  configure,
  configureGist,
  runInstallSetupCli,
  setup,
  setupAnalytics,
  symlinkBinaries,
};
