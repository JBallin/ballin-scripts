const fs = require('fs');
const path = require('path');
const {
  ensureAnalyticsInstallId,
} = require('./analytics.ts');
const {
  commandExists,
  readCommandOutput,
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const backupMarker = '### Backup of your dev environment\n'
  + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n'
  + '\n';

const readPrompt = (prompt: string): string => {
  process.stdout.write(prompt);

  const input: string[] = [];
  const buffer = Buffer.alloc(1);
  while (fs.readSync(0, buffer, 0, 1, null) > 0) {
    const character = buffer.toString('utf8');
    if (character === '\n') {
      break;
    }
    if (character !== '\r') {
      input.push(character);
    }
  }

  return input.join('');
};

const stripTrailingNewlines = (text: string): string => text.replace(/[\r\n]+$/u, '');
const supportedCommands = new Set([
  'configure',
  'gist',
  'setup',
  'setup-analytics',
  'symlink-binaries',
]);
const legacyCommandShims = ['gu', 'up'];

type ConfigObject = { [key: string]: unknown };

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const setupAnalyticsInstallId = (repoDir: string, configPath: string, docsUrl?: string): void => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigObject;
    const analyticsConfig = isConfigObject(config.analytics) ? config.analytics : undefined;
    ensureAnalyticsInstallId({
      analyticsConfig,
      docsUrl,
      env: process.env,
      repoDir,
      noticeWriter: (notice: string) => writeStdoutLine(`\n${notice}`),
    });
  } catch {
    // Analytics setup must never block install or update.
  }
};

const setupAnalytics = (repoDir: string, docsUrl?: string): boolean => {
  setupAnalyticsInstallId(repoDir, path.join(repoDir, 'ballin.config.json'), docsUrl);
  return true;
};

const configPathFor = (repoDir: string): string => path.join(repoDir, 'ballin.config.json');

const commandEnv = (cwd: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PWD: cwd,
});

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

const configValue = (ballinConfig: string, key: string): string | null => {
  const result = runCommand(ballinConfig, ['get', key]);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.trimEnd();
};

const setConfigValue = (ballinConfig: string, key: string, value: string): boolean => {
  const result = runCommand(ballinConfig, ['set', key, value]);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status === 0 && !result.error;
};

const runGh = (
  host: string,
  args: string[],
  options: { cwd: string } = { cwd: process.cwd() },
) => runCommand('gh', args, {
  cwd: options.cwd,
  env: {
    ...process.env,
    GH_HOST: host,
  },
});

const restoreAdoptedConfig = (
  repoDir: string,
  docsUrl: string,
  host: string,
  gistId: string,
): boolean => {
  const restoreConfig = path.join(repoDir, '.ballin.config.restore.tmp');
  const previousConfig = path.join(repoDir, '.ballin.config.restore.previous.tmp');
  const configPath = configPathFor(repoDir);
  let shouldRollback = false;

  try {
    fs.copyFileSync(configPath, previousConfig);

    const gistResult = runGh(host, ['gist', 'view', gistId, '--raw', '--filename', 'ballin_config'], {
      cwd: repoDir,
    });
    if (gistResult.stderr) {
      process.stderr.write(gistResult.stderr);
    }

    if (gistResult.status !== 0 || gistResult.error) {
      writeStdoutLine('\nℹ️  No ballin_config snapshot was found in that gist; keeping the local config defaults.');
      return true;
    }

    fs.writeFileSync(restoreConfig, gistResult.stdout);
    shouldRollback = true;
    fs.copyFileSync(restoreConfig, configPath);

    if (!updateConfig(repoDir, docsUrl)) {
      fs.copyFileSync(previousConfig, configPath);
      shouldRollback = false;
      return false;
    }

    shouldRollback = false;
    writeStdoutLine('\n♻️  Restored ballin.config.json from your backup gist.');
    return true;
  } finally {
    if (shouldRollback && fs.existsSync(previousConfig)) {
      fs.copyFileSync(previousConfig, configPath);
    }
    fs.rmSync(restoreConfig, { force: true });
    fs.rmSync(previousConfig, { force: true });
  }
};

const configureGist = (repoDir: string, docsUrl: string, guHostExisted: boolean): boolean => {
  const ballinConfig = path.join(repoDir, 'bin', 'ballin_config');
  let guHost = configValue(ballinConfig, 'gu.host');
  let guId = configValue(ballinConfig, 'gu.id');

  if (guHost === null || guId === null) {
    return false;
  }

  if (process.env.BALLIN_GU_HOST) {
    if (!setConfigValue(ballinConfig, 'gu.host', process.env.BALLIN_GU_HOST)) {
      return false;
    }
    guHost = configValue(ballinConfig, 'gu.host');
    if (guHost === null) {
      return false;
    }
  } else if (guId === 'null' || !guHostExisted) {
    const inputHost = readPrompt(`\n🤔 What GitHub host should be used for Gist backups? [${guHost}] `);
    if (inputHost) {
      if (!setConfigValue(ballinConfig, 'gu.host', inputHost)) {
        return false;
      }
      guHost = configValue(ballinConfig, 'gu.host');
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

  const authResult = runCommand('gh', ['auth', 'status', '--hostname', guHost], {
    cwd: repoDir,
    env: {
      ...process.env,
      GH_HOST: guHost,
    },
  });

  if (authResult.status !== 0 || authResult.error) {
    writeStdoutLine(`\n⚠️  ERROR: gh is not authenticated for ${guHost}.`);
    writeStdoutLine(`\nRun:\n  gh auth login --hostname ${guHost}`);
    writeStdoutLine('\nThen run this installer again.');
    return false;
  }

  if (guId !== 'null') {
    return true;
  }

  const hasBackup = readPrompt('\n🤔 Do you already have a ballin-scripts backup gist? [y/N] ');
  if (hasBackup === 'y' || hasBackup === 'Y') {
    writeStdoutLine('\nWelcome Back!');
    let validGistId = false;
    while (!validGistId) {
      const gistId = readPrompt('Enter your gist ID: ');
      const markerResult = runGh(guHost, ['gist', 'view', gistId, '--raw', '--filename', '.MyConfig.md'], {
        cwd: repoDir,
      });

      if (
        markerResult.status === 0
        && stripTrailingNewlines(markerResult.stdout) === stripTrailingNewlines(backupMarker)
      ) {
        writeStdoutLine('\n👍 Storing your previous gist ID in your config:');
        if (!restoreAdoptedConfig(repoDir, docsUrl, guHost, gistId)) {
          return false;
        }
        if (!setConfigValue(ballinConfig, 'gu.id', gistId)) {
          return false;
        }
        validGistId = true;
      } else {
        writeStdoutLine(`\n⚠️  INVALID: Expected backup marker in gist '${gistId}'.`);
      }
    }
  }

  guId = configValue(ballinConfig, 'gu.id');
  if (guId === null) {
    return false;
  }

  if (guId === 'null') {
    const markerPath = path.join(repoDir, '.MyConfig.md');
    fs.writeFileSync(markerPath, backupMarker);

    try {
      const createResult = runGh(guHost, ['gist', 'create', '.MyConfig.md', '--desc', backupMarker], {
        cwd: repoDir,
      });
      if (createResult.stderr) {
        process.stderr.write(createResult.stderr);
      }
      if (createResult.status !== 0 || createResult.error) {
        return false;
      }

      const gistUrl = createResult.stdout.trimEnd();
      writeStdoutLine(`\n💥 Created a secret gist titled '.MyConfig' at the following URL:\n${gistUrl}`);

      const createdGistId = gistUrl.split('/').pop() ?? gistUrl;
      writeStdoutLine('\n🧳 Storing your new gist ID in your config...');
      if (!setConfigValue(ballinConfig, 'gu.id', createdGistId)) {
        return false;
      }

      const guCacheDir = path.join(repoDir, '.gu-cache');
      if (fs.existsSync(guCacheDir) && fs.statSync(guCacheDir).isDirectory()) {
        fs.rmSync(guCacheDir, { recursive: true, force: true });
        writeStdoutLine('\n🗑  Deleted existing .gu-cache folder');
      }
    } finally {
      fs.rmSync(markerPath, { force: true });
    }
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
    legacyCommandShims.forEach((binName) => {
      const targetPath = path.join(binDir, binName);
      try {
        if (fs.lstatSync(targetPath).isSymbolicLink()
          && fs.readlinkSync(targetPath) === path.join(sourceBinDir, binName)) {
          fs.unlinkSync(targetPath);
        }
      } catch {
        // Missing or unrelated legacy shims do not affect current setup.
      }
    });

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

const setup = (repoDir: string, docsUrl: string, analyticsDocsUrl?: string): boolean => {
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

  setupAnalytics(repoDir, analyticsDocsUrl);

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

  if (command === 'supports-command') {
    process.exitCode = supportedCommands.has(repoDir) ? 0 : 1;
    return;
  }

  if (command === 'configure' && repoDir && option) {
    process.exitCode = configure(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'gist' && repoDir && option) {
    const guHostExisted = process.argv[5] === 'true';
    process.exitCode = configureGist(repoDir, option, guHostExisted) ? 0 : 1;
    return;
  }

  if (command === 'setup' && repoDir && option) {
    process.exitCode = setup(repoDir, option, process.argv[5]) ? 0 : 1;
    return;
  }

  if (command === 'symlink-binaries' && repoDir && option) {
    process.exitCode = symlinkBinaries(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'setup-analytics' && repoDir) {
    process.exitCode = setupAnalytics(repoDir, option) ? 0 : 1;
    return;
  }

  if (!command || !repoDir || !option) {
    writeStdoutLine('Usage: install_setup.ts <configure|gist|setup|symlink-binaries|setup-analytics|supports-command> <repo-dir|command> [docs-url|bin-dir] [gu-host-existed]');
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
