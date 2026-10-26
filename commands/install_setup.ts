const { terminalCommand } = require('./terminalStyle.ts');
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
  resolveBackupSetupHost,
} = require('./backup_config.ts');
const {
  promptInputState,
  CommandInterrupted,
  rethrowInterruption,
  commandExists,
  runCommand,
  requireUninterrupted,
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
type SetupMode = 'fresh' | 'refresh' | 'self-update';
type ConfigureBackupOptions = {
  hostname?: string;
  backupCacheDir?: string;
  configPath?: string;
  originalConfig?: Record<string, unknown>;
  onCancelled?: () => void;
  initialConsent?: boolean;
  presentation?: 'installation' | 'standalone';
  showValidationSummary?: boolean;
  maintenanceOnly?: boolean;
  reviewExistingSettings?: boolean;
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

  requireUninterrupted(updateResult);
  if (updateResult.stderr) {
    process.stderr.write(updateResult.stderr);
  }

  if (updateResult.status !== 0 || updateResult.error) {
    return false;
  }

  const updateOutput = updateResult.stdout.trimEnd();
  if (updateOutput) {
    writeStdoutLine(`\n🙌 ${updateOutput}`);
    writeStdoutLine(`\n${docsUrl}#what-installation-changes`);
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
    writeStdoutLine("⚙️  Created 'ballin.config.json' file in root using default settings");
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
    configPath, originalConfig, repositoryName: options.repositoryName, hostname: options.hostname, onCancelled: options.onCancelled,
    initialConsent: options.initialConsent,
    presentation: options.presentation,
    showValidationSummary: options.showValidationSummary,
    maintenanceOnly: options.maintenanceOnly,
    reviewExistingSettings: options.reviewExistingSettings,
    backupCacheDir: options.backupCacheDir ?? path.join(repoDir, '.backup-cache'),
  });
};

const commandTargetSnapshot = (target: string): string => {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'null';
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsafe command target');
  return JSON.stringify({ dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    link: stat.isSymbolicLink() ? fs.readlinkSync(target) : null });
};
type CommandPreflight = { directory: string; target: string; snapshot: string };
const symlinkBinaries = (repoDir: string, binDir: string, preflight?: CommandPreflight): boolean => {
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
      const current = commandTargetSnapshot(targetPath);
      if (preflight && (preflight.target !== targetPath || preflight.snapshot !== current)) {
        writeStdoutLine(`Command target changed after review: ${targetPath}. Inspect it before retrying installation.`);
        return false;
      }
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
    const result = runCommand('brew', ['--prefix']);
    requireUninterrupted(result);
    const brewPrefix = result.status === 0 && !result.error ? result.stdout : null;
    if (brewPrefix !== null) {
      const prefix = brewPrefix.trimEnd();
      if (!path.isAbsolute(prefix) || /[:\r\n\0]/u.test(prefix)) {
        writeStdoutLine(`Homebrew returned an invalid installation prefix. Inspect ${terminalCommand('brew --prefix')}, then rerun installation.`);
        return null;
      }
      return path.join(prefix, 'bin');
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
  writeStdoutLine(`Add ${terminalCommand(`export PATH="${binDir}:$PATH"`)} to your shell profile.`);
  writeStdoutLine('Then open a new terminal window and run the installer again.');
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
  let hostname: string | undefined;
  if (process.env.BALLIN_BACKUP_CHOICE === 'yes' && process.env.BALLIN_BACKUP_HOSTNAME !== undefined) {
    try {
      const destination = configuredBackupDestination(originalConfig);
      if (destination.kind === 'invalid') throw new Error('Invalid backup destination; disconnect before choosing another host.');
      hostname = resolveBackupSetupHost(originalConfig, process.env.BALLIN_BACKUP_HOSTNAME);
    } catch (error) {
      writeStdoutLine((error as Error).message);
      return false;
    }
  }
  const binDir = resolveBinDir();
  if (!binDir || !validateBinDirInPath(binDir)) {
    return false;
  }
  let preflight: CommandPreflight;
  try {
    const target = path.join(binDir, 'ballin');
    preflight = process.env.BALLIN_COMMAND_PREFLIGHT_JSON
      ? JSON.parse(process.env.BALLIN_COMMAND_PREFLIGHT_JSON)
      : { directory: binDir, target, snapshot: commandTargetSnapshot(target) };
    if (preflight.directory !== binDir || preflight.target !== target || typeof preflight.snapshot !== 'string'
      || preflight.snapshot !== commandTargetSnapshot(target)) throw new Error('Command target changed');
  } catch {
    writeStdoutLine('Unable to verify the reviewed command target. Inspect it before retrying installation.');
    return false;
  }

  const configExisted = fs.existsSync(configPathFor(repoDir));

  if (!configure(repoDir, docsUrl, configPathFor(repoDir), true)) {
    writeStdoutLine('\n⚠️  ERROR: Unable to create or update ballin.config.json');
    return false;
  }

  if (mode === 'fresh') {
    try {
      configureAnalyticsPreference({
        configPath: configPathFor(repoDir),
        docsUrl: analyticsDocsUrl,
        presentation: 'installation',
      });
    } catch (error) {
      rethrowInterruption(error);
      // Analytics setup must never block install.
    }
  }

  if (!symlinkBinaries(repoDir, binDir, preflight)) {
    return false;
  }

  if (mode === 'fresh' && promptInputState() === 'open') {
    offerCompletionSetup(docsUrl, { presentation: 'installation' });
    writeStdoutLine();
  }

  const destination = configuredBackupDestination(readJsonObject(configPathFor(repoDir)));
  const backupConfigured = destination.kind === 'repository';
  const backupInvalid = destination.kind === 'invalid';
  let backupSetupSucceeded = true;
  if (process.env.BALLIN_SKIP_BACKUP_SETUP === '1' || process.env.BALLIN_BACKUP_CHOICE === 'no' || promptInputState() !== 'open') {
    // A prior complete No or input end must not reopen optional onboarding.
  } else if (mode === 'fresh' || process.env.BALLIN_BACKUP_CHOICE === 'yes' || backupConfigured || backupInvalid) {
    let backupSetupCancelled = false;
    if (mode === 'refresh' && backupConfigured) writeStdoutLine();
    backupSetupSucceeded = configureBackup(repoDir, docsUrl, {
      presentation: mode === 'self-update' ? 'standalone' : 'installation',
      initialConsent: process.env.BALLIN_BACKUP_CHOICE === 'yes',
      hostname, originalConfig, onCancelled: () => { backupSetupCancelled = true; },
      showValidationSummary: mode !== 'self-update',
      maintenanceOnly: mode === 'self-update',
    });
    if (backupSetupCancelled) backupSetupSucceeded = true;
    else if (!backupSetupSucceeded) {
      writeStdoutLine('\n⚠️  ERROR: Unable to configure backup');
      writeStdoutLine(`\nBallin remains installed. Follow the backup recovery guidance above before retrying ${terminalCommand('ballin backup setup')}.`);
    }
  }

  setupAnalytics(repoDir);

  if (!configExisted && fs.existsSync(configPathFor(repoDir)) && mode !== 'fresh') {
    writeStdoutLine(`\n${docsUrl}#what-will-installation-change`);
  }

  if (backupSetupSucceeded && process.env.BALLIN_SETUP_RESULT_FILE) {
    const file = process.env.BALLIN_SETUP_RESULT_FILE;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Unsafe installer result file');
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, `complete ${destination.kind === 'repository' ? 'configured' : configuredBackupDestination(readJsonObject(configPathFor(repoDir))).kind === 'repository' ? 'configured' : 'skipped'} ${promptInputState()}\n`);
    } finally { fs.closeSync(fd); }
  }
  return backupSetupSucceeded;
};

const runInstallSetupCommand = (): void => {
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
    const mode = process.argv[6] === 'fresh' ? 'fresh'
      : process.argv[6] === 'self-update' ? 'self-update' : 'refresh';
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
    writeStdoutLine('Usage: install_setup.ts <configure|setup|symlink-binaries|setup-analytics|supports-command> <repo-dir|command> [docs-url|bin-dir] [analytics-docs-url] [fresh|refresh|self-update]');
    process.exitCode = 1;
    return;
  }

  writeStdoutLine(`Unknown install setup command: ${command}`);
  process.exitCode = 1;
};

const runInstallSetupCli = (): void => {
  try { runInstallSetupCommand(); } catch (error) {
    if (!(error instanceof CommandInterrupted)) throw error;
    process.exitCode = (error as { status: number }).status;
    writeStdoutLine((error as Error).message);
  }
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
