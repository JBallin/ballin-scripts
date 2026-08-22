const fs = require('fs');
const path = require('path');
const {
  ensureAnalyticsInstallId,
} = require('./analytics.ts');
const {
  createConfigStore,
  stringify,
} = require('../config/store.ts');
const {
  backupDestinationFromConfig,
  normalizeBackupHost,
} = require('./backup_config.ts');
const {
  commandExists,
  readCommandOutput,
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const backupMarker = '### Backup of your dev environment\n'
  + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n'
  + '\n';
const configSnapshotFileName = 'ballin_config';
const backupSafetyNotice = [
  'Ballin can store selected development configuration in a secret GitHub Gist.',
  'Setup only creates or adopts the destination; snapshots are collected and uploaded later by ballin backup.',
  'Secret Gists are unlisted, not private: anyone with the URL or Gist ID can view them.',
  'Shell, Git, and editor configuration may contain tokens, credentials, private URLs, or other sensitive values you added.',
  'Ballin is not a secrets manager. Review sensitive configuration and do not share the Gist URL or ID.',
].join('\n');

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

type ConfigObject = { [key: string]: ConfigValue };
type ConfigLeaf = string | number | boolean | null;
type ConfigValue = ConfigLeaf | ConfigObject;
type SetupMode = 'fresh' | 'refresh';
type ConfigureGistOptions = {
  backupCacheDir?: string;
  configPath?: string;
};

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const configPathFor = (repoDir: string): string => path.join(repoDir, 'ballin.config.json');

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

const setupAnalytics = (repoDir: string, docsUrl?: string, configPath = configPathFor(repoDir)): boolean => {
  setupAnalyticsInstallId(repoDir, configPath, docsUrl);
  return true;
};

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

const backupDestinationForConfig = (filePath: string) => {
  const config = readJsonObject(filePath);
  return config ? backupDestinationFromConfig(config) : null;
};

const configHasBackupHost = (repoDir: string, configPath = configPathFor(repoDir)): boolean => {
  const config = readJsonObject(configPath);
  return isConfigObject(config?.backup) && Object.prototype.hasOwnProperty.call(config.backup, 'host');
};

const updateConfig = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir)): boolean => {
  const updateConfigPath = path.join(repoDir, 'config', 'updateConfig.ts');
  const childEnv = commandEnv(path.join(repoDir, 'config'));
  childEnv.BALLIN_TEST_CONFIG_PATH = configPath;

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

const configure = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir)): boolean => {
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

  return updateConfig(repoDir, docsUrl, configPath);
};

const configValue = (configPath: string, key: string): ConfigLeaf | undefined => (
  createConfigStore({ configPath }).readLeafValue(key)
);

const setConfigValue = (configPath: string, key: string, value: string): boolean => {
  if (!createConfigStore({ configPath }).writeLeafValue(key, value)) {
    return false;
  }
  process.stdout.write(`"${key}" set to: ${JSON.stringify(value)}\n`);
  return true;
};

const replaceInvalidBackupHost = (configPath: string, value: string): boolean => {
  const config = readJsonObject(configPath);
  if (
    !config
    || !isConfigObject(config.backup)
    || !Object.prototype.hasOwnProperty.call(config.backup, 'host')
  ) {
    return false;
  }

  try {
    config.backup.host = value;
    fs.writeFileSync(configPath, stringify(config), 'utf8');
    process.stdout.write(`"backup.host" set to: ${JSON.stringify(value)}\n`);
    return true;
  } catch {
    return false;
  }
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

const restorePreviousConfig = (configPath: string, previousConfig: string): void => {
  try {
    if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== previousConfig) {
      fs.writeFileSync(configPath, previousConfig, 'utf8');
    }
  } catch {
    // The original config normally remains untouched until the final rename.
  }
};

const commitAdoptedConfig = (
  repoDir: string,
  docsUrl: string,
  host: string,
  gistId: string,
  configPath: string,
): boolean => {
  const restoreConfig = `${configPath}.${process.pid}.restore.tmp`;
  let previousConfig: string | undefined;
  let restoredSnapshot = false;

  try {
    previousConfig = fs.readFileSync(configPath, 'utf8');

    const filesResult = runGh(host, ['gist', 'view', '--files', '--', gistId], {
      cwd: repoDir,
    });
    if (filesResult.stderr) {
      process.stderr.write(filesResult.stderr);
    }

    if (filesResult.status !== 0 || filesResult.error) {
      writeStdoutLine(`\n⚠️  ERROR: Unable to inspect ${configSnapshotFileName} in the adopted Gist.`);
      return false;
    }

    const hasConfigSnapshot = filesResult.stdout
      .split(/\r?\n/u)
      .some((fileName: string) => fileName.trim() === configSnapshotFileName);

    if (!hasConfigSnapshot) {
      writeStdoutLine(`\nℹ️  No ${configSnapshotFileName} snapshot was found in that gist; keeping the local config defaults.`);
      fs.writeFileSync(restoreConfig, previousConfig, 'utf8');
    } else {
      const gistResult = runGh(host, ['gist', 'view', gistId, '--raw', '--filename', configSnapshotFileName], {
        cwd: repoDir,
      });
      if (gistResult.stderr) {
        process.stderr.write(gistResult.stderr);
      }
      if (gistResult.status !== 0 || gistResult.error) {
        writeStdoutLine(`\n⚠️  ERROR: Unable to read ${configSnapshotFileName} from the adopted Gist.`);
        return false;
      }
      fs.writeFileSync(restoreConfig, gistResult.stdout, 'utf8');
      restoredSnapshot = true;
    }

    if (!updateConfig(repoDir, docsUrl, restoreConfig)) {
      return false;
    }

    const candidate = readJsonObject(restoreConfig);
    const candidateBackup = candidate?.backup;
    if (!candidate || !isConfigObject(candidateBackup)) {
      return false;
    }
    candidateBackup.host = host;
    candidateBackup.id = gistId;
    fs.writeFileSync(restoreConfig, stringify(candidate), 'utf8');

    try {
      if (process.env.BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT === '1') {
        throw new Error('Simulated final config commit failure');
      }
      fs.renameSync(restoreConfig, configPath);
    } catch {
      if (previousConfig !== undefined) {
        restorePreviousConfig(configPath, previousConfig);
      }
      return false;
    }

    if (restoredSnapshot) {
      writeStdoutLine('\n♻️  Restored ballin.config.json from your backup gist.');
    }
    return true;
  } catch {
    if (previousConfig !== undefined) {
      restorePreviousConfig(configPath, previousConfig);
    }
    return false;
  } finally {
    fs.rmSync(restoreConfig, { force: true });
  }
};

const invalidateBackupCache = (backupCacheDir: string): boolean => {
  let existed = false;
  try {
    existed = fs.existsSync(backupCacheDir);
    fs.rmSync(backupCacheDir, { recursive: true, force: true });
  } catch {
    writeStdoutLine(`\n⚠️  ERROR: Unable to invalidate ${backupCacheDir}`);
    return false;
  }

  if (existed) {
    writeStdoutLine('\n🗑  Invalidated existing .backup-cache');
  }
  return true;
};

const configureGist = (
  repoDir: string,
  docsUrl: string,
  backupHostExisted: boolean,
  options: ConfigureGistOptions = {},
): boolean => {
  const ballinConfig = options.configPath ?? configPathFor(repoDir);
  const backupCacheDir = options.backupCacheDir ?? path.join(repoDir, '.backup-cache');
  const destination = backupDestinationForConfig(ballinConfig);
  if (!destination) {
    return false;
  }
  if (destination.idStatus === 'invalid') {
    writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.id; expected null or a non-empty string.');
    writeStdoutLine('Run ballin config reset to restore valid defaults, then run ballin backup setup if needed.');
    return false;
  }

  let backupHost = destination.host;
  const backupId = destination.id;
  const backupHostInvalid = backupHostExisted && !backupHost;
  const deferHostPersistence = Boolean(backupId && backupHostInvalid);
  let pendingBackupHost: string | null = null;

  if (backupHostInvalid) {
    writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.host; expected a non-empty string.');
  }

  if (!backupId) {
    writeStdoutLine(`\n${backupSafetyNotice}`);
    writeStdoutLine(`Details: ${docsUrl}`);
    const proceed = readPrompt('\n🤔 Set up optional Gist backups now? [y/N] ');
    if (proceed !== 'y' && proceed !== 'Y') {
      writeStdoutLine('\nℹ️  Backup setup skipped. Run ballin backup setup when you are ready.');
      return true;
    }
  }

  if (process.env.BALLIN_BACKUP_HOST) {
    const replacementHost = normalizeBackupHost(process.env.BALLIN_BACKUP_HOST);
    if (!replacementHost) {
      return false;
    }
    if (deferHostPersistence) {
      pendingBackupHost = replacementHost;
      backupHost = replacementHost;
    } else {
      const hostSaved = backupHostInvalid
        ? replaceInvalidBackupHost(ballinConfig, replacementHost)
        : setConfigValue(ballinConfig, 'backup.host', replacementHost);
      if (!hostSaved) {
        return false;
      }
      backupHost = normalizeBackupHost(configValue(ballinConfig, 'backup.host'));
      if (!backupHost) {
        return false;
      }
    }
  } else if (!backupId || !backupHostExisted || backupHostInvalid) {
    const suggestedHost = backupHost ?? 'github.com';
    const inputHost = readPrompt(`\n🤔 What GitHub host should be used for Gist backups? [${suggestedHost}] `);
    const replacementHost = inputHost || (backupHostInvalid ? suggestedHost : null);
    if (replacementHost) {
      const normalizedReplacementHost = normalizeBackupHost(replacementHost);
      if (!normalizedReplacementHost) {
        writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.host; expected a non-empty string.');
        return false;
      }
      if (deferHostPersistence) {
        pendingBackupHost = normalizedReplacementHost;
        backupHost = normalizedReplacementHost;
      } else {
        const hostSaved = backupHostInvalid
          ? replaceInvalidBackupHost(ballinConfig, normalizedReplacementHost)
          : setConfigValue(ballinConfig, 'backup.host', normalizedReplacementHost);
        if (!hostSaved) {
          return false;
        }
        backupHost = normalizeBackupHost(configValue(ballinConfig, 'backup.host'));
        if (!backupHost) {
          writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.host; expected a non-empty string.');
          return false;
        }
      }
    }
  }

  if (!backupHost) {
    return false;
  }
  const selectedHost = backupHost;

  if (!commandExists('gh')) {
    writeStdoutLine('\n⚠️  ERROR: GitHub CLI is required for Gist backup setup.');
    writeStdoutLine('\nInstall gh, authenticate it, then run ballin backup setup again.');
    writeStdoutLine(`\nSetup guide: ${docsUrl}`);
    writeStdoutLine(`\nRun after installing gh:\n  gh auth login --hostname ${selectedHost}`);
    return false;
  }

  const authResult = runCommand('gh', ['auth', 'status', '--hostname', selectedHost], {
    cwd: repoDir,
    env: {
      ...process.env,
      GH_HOST: selectedHost,
    },
  });

  if (authResult.status !== 0 || authResult.error) {
    writeStdoutLine(`\n⚠️  ERROR: gh is not authenticated for ${selectedHost}.`);
    writeStdoutLine(`\nRun:\n  gh auth login --hostname ${selectedHost}`);
    writeStdoutLine('\nThen run ballin backup setup again.');
    return false;
  }

  if (backupId) {
    if (pendingBackupHost) {
      const markerResult = runGh(
        selectedHost,
        ['gist', 'view', backupId, '--raw', '--filename', '.MyConfig.md'],
        { cwd: repoDir },
      );
      if (markerResult.stderr) {
        process.stderr.write(markerResult.stderr);
      }
      if (
        markerResult.status !== 0
        || markerResult.error
        || stripTrailingNewlines(markerResult.stdout) !== stripTrailingNewlines(backupMarker)
      ) {
        writeStdoutLine(`\n⚠️  ERROR: Gist '${backupId}' on ${selectedHost} is not a valid Ballin backup destination.`);
        writeStdoutLine('The existing backup.host was not changed. Verify the host and Gist ID, then retry with ballin backup setup.');
        return false;
      }
      if (!replaceInvalidBackupHost(ballinConfig, pendingBackupHost)) {
        return false;
      }
    }
    return true;
  }

  const hasBackup = readPrompt('\n🤔 Do you already have a Ballin backup Gist? [y/N] ');
  if (hasBackup === 'y' || hasBackup === 'Y') {
    writeStdoutLine('\nWelcome Back!');
    let validGistId = false;
    while (!validGistId) {
      const gistId = readPrompt('Enter your gist ID: ').trim();
      if (!gistId) {
        writeStdoutLine('\nℹ️  Backup Gist adoption cancelled; no destination was configured.');
        writeStdoutLine('Retry with: ballin backup setup');
        return false;
      }
      const markerResult = runGh(selectedHost, ['gist', 'view', gistId, '--raw', '--filename', '.MyConfig.md'], {
        cwd: repoDir,
      });

      if (
        markerResult.status === 0
        && stripTrailingNewlines(markerResult.stdout) === stripTrailingNewlines(backupMarker)
      ) {
        writeStdoutLine('\n👍 Validated your previous backup Gist; preparing its configuration:');
        if (!invalidateBackupCache(backupCacheDir)) {
          return false;
        }
        if (!commitAdoptedConfig(repoDir, docsUrl, selectedHost, gistId, ballinConfig)) {
          return false;
        }
        validGistId = true;
      } else {
        writeStdoutLine(`\n⚠️  INVALID: Expected backup marker in gist '${gistId}'.`);
      }
    }
  }

  if (backupDestinationForConfig(ballinConfig)?.idStatus !== 'configured') {
    if (!invalidateBackupCache(backupCacheDir)) {
      return false;
    }
    const markerPath = path.join(repoDir, '.MyConfig.md');
    fs.writeFileSync(markerPath, backupMarker);

    try {
      const createResult = runGh(selectedHost, ['gist', 'create', '.MyConfig.md', '--desc', backupMarker], {
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
      if (!setConfigValue(ballinConfig, 'backup.id', createdGistId)) {
        return false;
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

const setup = (
  repoDir: string,
  docsUrl: string,
  analyticsDocsUrl?: string,
  mode: SetupMode = 'refresh',
): boolean => {
  const binDir = resolveBinDir();
  if (!binDir || !validateBinDirInPath(binDir)) {
    return false;
  }

  const configExisted = fs.existsSync(configPathFor(repoDir));
  const backupHostExisted = configExisted && configHasBackupHost(repoDir);

  if (!configure(repoDir, docsUrl)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to create or update ballin.config.json');
    return false;
  }

  if (!symlinkBinaries(repoDir, binDir)) {
    return false;
  }

  const backupIdStatus = backupDestinationForConfig(configPathFor(repoDir))?.idStatus;
  const backupConfigured = backupIdStatus === 'configured';
  const backupInvalid = backupIdStatus === 'invalid';
  let backupSetupSucceeded = true;
  if (mode === 'fresh' || backupConfigured || backupInvalid) {
    backupSetupSucceeded = configureGist(repoDir, docsUrl, backupHostExisted);
    if (!backupSetupSucceeded) {
      writeStdoutLine('\n⚠️  ERROR: Unable to configure Gist backup');
      writeStdoutLine('\nBallin maintenance is installed. Retry with: ballin backup setup');
    }
  }

  setupAnalytics(repoDir, analyticsDocsUrl);

  if (!configExisted && fs.existsSync(configPathFor(repoDir))) {
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  if (backupSetupSucceeded) {
    writeStdoutLine('\n😎 ballin!');
  }
  return backupSetupSucceeded;
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
    const backupHostExisted = process.argv[5] === 'true';
    process.exitCode = configureGist(repoDir, option, backupHostExisted) ? 0 : 1;
    return;
  }

  if (command === 'setup' && repoDir && option) {
    const mode = process.argv[6] === 'fresh' ? 'fresh' : 'refresh';
    process.exitCode = setup(repoDir, option, process.argv[5], mode) ? 0 : 1;
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
    writeStdoutLine('Usage: install_setup.ts <configure|gist|setup|symlink-binaries|setup-analytics|supports-command> <repo-dir|command> [docs-url|bin-dir] [backup-host-existed|analytics-docs-url] [fresh|refresh]');
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
  commitAdoptedConfig,
  configHasBackupHost,
  configureGist,
  invalidateBackupCache,
  runInstallSetupCli,
  setup,
  setupAnalytics,
  symlinkBinaries,
};
