const fs = require('fs');
const { offerCompletionSetup } = require('./completion_setup.ts');
const path = require('path');
const {
  configureAnalyticsPreference,
  ensureAnalyticsInstallId,
} = require('./analytics.ts');
const {
  stringify,
} = require('../config/store.ts');
const {
  PortableConfigError,
  readSetupConfigContext,
} = require('../config/portable.ts');
const {
  configuredBackupDestination,
} = require('./backup_config.ts');
const {
  commandExists,
  readCommandOutput,
  runNodeScript,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const { configureRepositoryBackup, disconnectBackup } = require('./backup_setup.ts');

const supportedCommands = new Set([
  'configure',
  'setup',
  'setup-analytics',
  'symlink-binaries',
]);

type ConfigObject = { [key: string]: ConfigValue };
type ConfigLeaf = string | number | boolean | null;
type ConfigValue = ConfigLeaf | ConfigObject;
type SetupMode = 'fresh' | 'refresh';
type ConfigureBackupOptions = {
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

const setupAnalyticsInstallId = (repoDir: string, configPath: string): void => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigObject;
    const analyticsConfig = isConfigObject(config.analytics) ? config.analytics : undefined;
    ensureAnalyticsInstallId({
      analyticsConfig,
      env: process.env,
      repoDir,
    });
  } catch {
    // Analytics setup must never block install or update.
  }
};

const setupAnalytics = (repoDir: string, configPath = configPathFor(repoDir)): boolean => {
  setupAnalyticsInstallId(repoDir, configPath);
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
    writeStdoutLine("🧠 Created 'ballin.config.json' file in root using default settings");
    return true;
  }

  return updateConfig(repoDir, docsUrl, configPath, deferBackupSelection);
};

const configureBackup = (
  repoDir: string, docsUrl: string,
  options: ConfigureBackupOptions & { repositoryName?: string } = {},
): boolean => {
  const configPath = options.configPath ?? configPathFor(repoDir);
  const originalConfig = options.originalConfig ?? readOriginalSetupConfig(configPath);
  if (!originalConfig) return false;
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
  writeStdoutLine(`Add \`export PATH="${binDir}:$PATH"\` to your shell profile.`);
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

  if (!configExisted) writeStdoutLine();
  if (!configure(repoDir, docsUrl, configPathFor(repoDir), true)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to create or update ballin.config.json');
    return false;
  }

  if (mode === 'fresh') {
    try {
      configureAnalyticsPreference({
        configPath: configPathFor(repoDir),
        docsUrl: analyticsDocsUrl,
      });
    } catch {
      // Analytics setup must never block install.
    }
  }

  if (!symlinkBinaries(repoDir, binDir)) {
    return false;
  }

  if (mode === 'fresh') offerCompletionSetup(docsUrl);

  const destination = configuredBackupDestination(readJsonObject(configPathFor(repoDir)));
  const backupConfigured = destination.kind === 'repository' || destination.kind === 'legacy-gist';
  const backupInvalid = destination.kind === 'invalid';
  let backupSetupSucceeded = true;
  if (mode === 'fresh' || backupConfigured || backupInvalid) {
    backupSetupSucceeded = configureBackup(repoDir, docsUrl, { originalConfig });
    if (!backupSetupSucceeded) {
      writeStdoutLine('\n⚠️  ERROR: Unable to configure backup');
      writeStdoutLine('\nBallin maintenance is installed. Retry with: `ballin backup setup`');
    }
  }

  setupAnalytics(repoDir);

  if (!configExisted && fs.existsSync(configPathFor(repoDir))) {
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  if (backupSetupSucceeded && mode === 'fresh') {
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
    process.exitCode = setupAnalytics(repoDir) ? 0 : 1;
    return;
  }

  if (!command || !repoDir || !option) {
    writeStdoutLine('Usage: install_setup.ts <configure|setup|symlink-binaries|setup-analytics|supports-command> <repo-dir|command> [docs-url|bin-dir] [analytics-docs-url] [fresh|refresh]');
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
  configureBackup,
  disconnectBackup,
  readOriginalSetupConfig,
  runInstallSetupCli,
  setup,
  setupAnalytics,
  symlinkBinaries,
};
