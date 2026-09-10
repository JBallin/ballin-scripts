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
  PortableConfigError,
  readSetupConfigContext,
} = require('../config/portable.ts');
const {
  backupDestinationFromConfig,
  configuredBackupDestination,
  normalizeBackupHost,
} = require('./backup_config.ts');
const {
  commandExists,
  readCommandOutput,
  runCommand,
  runNodeScript,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  backupMarkerFileName,
} = require('./backup_snapshots.ts');

const backupMarker = '### Backup of your dev environment\n'
  + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n'
  + '\n';
const { readPrompt, configureRepositoryBackup, disconnectBackup } = require('./backup_setup.ts');

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
  originalConfig?: Record<string, unknown>;
};

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const configPathFor = (repoDir: string): string => path.join(repoDir, 'ballin.config.json');

// Capture choices before configure() supplies defaults for this invocation.
const readOriginalSetupConfig = (configPath: string): Record<string, unknown> | null => {
  try {
    return readSetupConfigContext(configPath);
  } catch (error) {
    const message = error instanceof PortableConfigError
      ? (error as Error).message
      : 'Unable to inspect local configuration.';
    writeStdoutLine(`\n⚠️  ERROR: ${message}`);
    writeStdoutLine('Repair the local configuration before retrying setup.');
    return null;
  }
};

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

const updateConfig = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir), deferBackupSelection = false): boolean => {
  const updateConfigPath = path.join(repoDir, 'config', 'updateConfig.ts');
  const childEnv = commandEnv(path.join(repoDir, 'config'));
  childEnv.BALLIN_TEST_CONFIG_PATH = configPath;
  childEnv.BALLIN_DEFER_BACKUP_SELECTION = deferBackupSelection ? '1' : '0';

  const updateResult = runNodeScript(updateConfigPath, {
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

const configure = (repoDir: string, docsUrl: string, configPath = configPathFor(repoDir), deferBackupSelection = false): boolean => {
  const defaultConfigPath = path.join(repoDir, 'config', '.defaultConfig.json');

  if (!fs.existsSync(configPath)) {
    try {
      if (deferBackupSelection) {
        const defaults = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
        delete defaults.backup.repository;
        delete defaults.backup.includeSensitive;
        fs.writeFileSync(configPath, stringify(defaults));
      } else fs.copyFileSync(defaultConfigPath, configPath);
    } catch {
      return false;
    }
    writeStdoutLine("\n🧠 Created 'ballin.config.json' file in root using default settings");
    return true;
  }

  return updateConfig(repoDir, docsUrl, configPath, deferBackupSelection);
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

const configureGist = (
  repoDir: string,
  docsUrl: string,
  backupHostExisted: boolean,
  options: ConfigureGistOptions = {},
): boolean => {
  const ballinConfig = options.configPath ?? configPathFor(repoDir);
  const originalConfig = options.originalConfig ?? readOriginalSetupConfig(ballinConfig);
  if (!originalConfig) {
    return false;
  }
  const destination = backupDestinationForConfig(ballinConfig);
  if (!destination) {
    return false;
  }
  if (destination.idStatus === 'invalid') {
    writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.id; expected null or a non-empty string.');
    writeStdoutLine('Run ballin config reset to restore valid defaults, then run ballin backup setup if needed.');
    return false;
  }
  if (configuredBackupDestination(readJsonObject(ballinConfig)).kind === 'invalid') {
    writeStdoutLine('Repair the backup destination configuration before using the Gist compatibility entrypoint.');
    return false;
  }

  let backupHost = destination.host;
  const backupId = destination.id;
  const backupHostInvalid = backupHostExisted && !backupHost;
  const deferHostPersistence = backupHostInvalid;
  let pendingBackupHost: string | null = null;

  if (backupHostInvalid) {
    writeStdoutLine('\n⚠️  ERROR: Invalid config value backup.host; expected a non-empty string.');
  }

  if (!backupId) {
    writeStdoutLine('New Gist setup is retired. Run ballin backup setup to configure a private repository.');
    return false;
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
      const hostSaved = setConfigValue(ballinConfig, 'backup.host', replacementHost);
      if (!hostSaved) {
        return false;
      }
      backupHost = normalizeBackupHost(configValue(ballinConfig, 'backup.host'));
      if (!backupHost) {
        return false;
      }
    }
  } else if (!backupHostExisted || backupHostInvalid) {
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
        const hostSaved = setConfigValue(ballinConfig, 'backup.host', normalizedReplacementHost);
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

  const authResult = runGh(selectedHost, ['api', '--hostname', selectedHost, 'user'], {
    cwd: repoDir,
  });

  if (authResult.status !== 0 || authResult.error) {
    writeStdoutLine(`\n⚠️  ERROR: gh is not authenticated for ${selectedHost}.`);
    writeStdoutLine(`\nRun:\n  gh auth login --hostname ${selectedHost}`);
    writeStdoutLine('\nThen run ballin backup setup again.');
    return false;
  }

  if (pendingBackupHost) {
    const markerResult = runGh(
      selectedHost,
      ['gist', 'view', backupId, '--raw', '--filename', backupMarkerFileName],
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
};

const configureBackup = (
  repoDir: string, docsUrl: string, backupHostExisted: boolean,
  options: ConfigureGistOptions & { repositoryName?: string } = {},
): boolean => {
  const configPath = options.configPath ?? configPathFor(repoDir);
  const originalConfig = options.originalConfig ?? readOriginalSetupConfig(configPath);
  if (!originalConfig) return false;
  const destination = configuredBackupDestination(readJsonObject(configPath));
  if (destination.kind === 'legacy-gist') {
    if (options.repositoryName !== undefined) {
      writeStdoutLine('This installation still uses a Gist. Migration is separate; disconnect before setting up an independent repository.');
      return false;
    }
    writeStdoutLine('Existing Gist backup remains configured. Setup does not migrate or replace it with a repository.');
    return configureGist(repoDir, docsUrl, backupHostExisted, options);
  }
  return configureRepositoryBackup({
    configPath, originalConfig, repositoryName: options.repositoryName,
    backupCacheDir: options.backupCacheDir ?? path.join(repoDir, '.backup-cache'),
  });
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
  const originalConfig = readOriginalSetupConfig(configPathFor(repoDir));
  if (!originalConfig) {
    return false;
  }
  const binDir = resolveBinDir();
  if (!binDir || !validateBinDirInPath(binDir)) {
    return false;
  }

  const configExisted = fs.existsSync(configPathFor(repoDir));
  const backupHostExisted = configExisted && configHasBackupHost(repoDir);

  if (!configure(repoDir, docsUrl, configPathFor(repoDir), true)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to create or update ballin.config.json');
    return false;
  }

  if (!symlinkBinaries(repoDir, binDir)) {
    return false;
  }

  const destination = configuredBackupDestination(readJsonObject(configPathFor(repoDir)));
  const backupConfigured = destination.kind === 'repository' || destination.kind === 'legacy-gist';
  const backupInvalid = destination.kind === 'invalid';
  let backupSetupSucceeded = true;
  if (mode === 'fresh' || backupConfigured || backupInvalid) {
    backupSetupSucceeded = configureBackup(repoDir, docsUrl, backupHostExisted, { originalConfig });
    if (!backupSetupSucceeded) {
      writeStdoutLine('\n⚠️  ERROR: Unable to configure backup');
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
  configHasBackupHost,
  configureGist,
  configureBackup,
  disconnectBackup,
  readOriginalSetupConfig,
  runInstallSetupCli,
  setup,
  setupAnalytics,
  symlinkBinaries,
};
