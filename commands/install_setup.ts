const { terminalCommand, terminalPath, terminalError, terminalComplete, terminalProse } = require('./terminalStyle.ts');
const fs = require('fs');
const { offerCompletionSetup } = require('./completion_setup.ts');
const path = require('path');
const {
  ensureAnalyticsInstallId,
} = require('./analytics.ts');
const {
  configuredBackupDestination,
  resolveBackupSetupHost,
} = require('./backup_config.ts');
const {
  promptInputState,
  CommandInterrupted,
  commandExists,
  requireUninterrupted,
  runCommand,
  writeStdoutLine,
  writeStderrLine,
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
  configPrepared?: boolean;
  originalConfig?: Record<string, unknown>;
  onCancelled?: () => void;
  initialConsent?: boolean;
  presentation?: 'installation' | 'standalone';
  deferFollowUp?: boolean;
  showValidationSummary?: boolean;
  maintenanceOnly?: boolean;
  reviewExistingSettings?: boolean;
};

const { isConfigObject, configPathFor, readOriginalSetupConfig, createDefaultConfig, configure } = require('../config/setup.ts');
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

const readJsonObject = (filePath: string): ConfigObject | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isConfigObject(parsed) ? parsed as ConfigObject : null;
  } catch {
    return null;
  }
};

const configureBackup = (
  repoDir: string, docsUrl: string,
  options: ConfigureBackupOptions & { repositoryName?: string } = {},
): boolean => {
  const configPath = options.configPath ?? configPathFor(repoDir);
  return configureRepositoryBackup({
    configPath, repoDir, docsUrl, configPrepared: options.configPrepared, originalConfig: options.originalConfig, repositoryName: options.repositoryName, hostname: options.hostname, onCancelled: options.onCancelled,
    initialConsent: options.initialConsent,
    presentation: options.presentation,
    deferFollowUp: options.deferFollowUp,
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
    writeStdoutLine(`\n${terminalError(`Unable to create ${terminalPath(binDir)}`)}`);
    return false;
  }

  try {
    for (const binName of fs.readdirSync(sourceBinDir)) {
      const sourcePath = path.join(sourceBinDir, binName);
      const targetPath = path.join(binDir, binName);
      const current = commandTargetSnapshot(targetPath);
      if (preflight && (preflight.target !== targetPath || preflight.snapshot !== current)) {
        writeStdoutLine(`Command target changed after review: ${terminalPath(targetPath)}. Inspect it before retrying.`);
        return false;
      }
      fs.rmSync(targetPath, { force: true });
      fs.symlinkSync(sourcePath, targetPath);
    }
  } catch {
    writeStdoutLine(`\n${terminalError(`Unable to symlink binaries into ${terminalPath(binDir)}`)}`);
    return false;
  }

  return true;
};

const setupRetry = (mode: SetupMode): string => mode === 'fresh' ? 'run the installer again'
  : mode === 'self-update' ? `run ${terminalCommand('ballin self-update')} again`
    : `use ${terminalCommand('ballin self-update')} for the default selection`;
const resolveBinDir = (mode: SetupMode): string | null => {
  if (commandExists('brew')) {
    const result = runCommand('brew', ['--prefix']);
    requireUninterrupted(result);
    const brewPrefix = result.status === 0 && !result.error ? result.stdout : null;
    if (brewPrefix !== null) {
      const prefix = brewPrefix.trimEnd();
      if (!path.isAbsolute(prefix) || /[:\r\n\0]/u.test(prefix)) {
        writeStdoutLine(terminalError('Homebrew returned an invalid installation prefix.'));
        writeStdoutLine(`Inspect ${terminalCommand('brew --prefix')}, then ${setupRetry(mode)}.`);
        return null;
      }
      return path.join(prefix, 'bin');
    }
  }

  const homeDir = process.env.HOME;
  return homeDir ? path.join(homeDir, '.local', 'bin') : null;
};

const validateBinDirInPath = (binDir: string, mode: SetupMode): boolean => {
  const envPath = process.env.PATH ?? '';
  if (envPath.split(path.delimiter).includes(binDir)) {
    return true;
  }

  writeStdoutLine(`\n${terminalError(`${terminalPath(binDir)} doesn't seem to be in your path.`)}`);
  writeStdoutLine(`Add ${terminalCommand(`export PATH="${binDir}:$PATH"`)} to your shell profile.`);
  writeStdoutLine(`Then open a new terminal window and ${setupRetry(mode)}.`);
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
      writeStdoutLine(terminalError((error as Error).message));
      return false;
    }
  }
  const binDir = resolveBinDir(mode);
  if (!binDir || !validateBinDirInPath(binDir, mode)) {
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
    writeStdoutLine(terminalError('Unable to verify the reviewed command target.'));
    writeStdoutLine('Inspect it before retrying.');
    return false;
  }

  const configExisted = fs.existsSync(configPathFor(repoDir));

  if (!configure(repoDir, docsUrl, configPathFor(repoDir), true)) {
    writeStdoutLine(`\n${terminalError('Unable to create or update ballin.config.json')}`);
    return false;
  }

  if (!symlinkBinaries(repoDir, binDir, preflight)) {
    return false;
  }

  if (mode === 'fresh' && promptInputState() === 'open') {
    offerCompletionSetup(docsUrl, { presentation: 'installation' });
  }

  const destination = configuredBackupDestination(readJsonObject(configPathFor(repoDir)));
  const backupConfigured = destination.kind === 'repository';
  const backupInvalid = destination.kind === 'invalid';
  let backupSetupSucceeded = true;
  let backupFlow = false;
  let backupSetupCancelled = false;
  let generalReview = false;
  const interactive = mode !== 'self-update' && promptInputState() === 'open';
  const backupSetupAllowed = mode === 'self-update' || process.env.BALLIN_BACKUP_CHOICE !== 'no';
  if (mode !== 'self-update' && (interactive || backupConfigured || backupInvalid)) writeStdoutLine(`\n${terminalComplete('Ballin installed successfully.')}`);
  if (backupSetupAllowed && (backupConfigured || backupInvalid
    || (interactive && process.env.BALLIN_SKIP_BACKUP_SETUP !== '1'))) {
    backupFlow = true;
    if (mode !== 'self-update') writeStdoutLine();
    backupSetupSucceeded = configureBackup(repoDir, docsUrl, {
      presentation: mode === 'self-update' ? 'standalone' : 'installation', configPrepared: true, deferFollowUp: true,
      initialConsent: process.env.BALLIN_BACKUP_CHOICE === 'yes',
      hostname, originalConfig, onCancelled: () => { backupSetupCancelled = true; },
      showValidationSummary: mode !== 'self-update',
      maintenanceOnly: mode === 'self-update',
    });
    if (!backupSetupSucceeded && !backupSetupCancelled) return false;
    if (backupSetupCancelled) backupSetupSucceeded = true;
  }
  if (interactive && promptInputState() === 'open') {
    const { readYesNo } = require('./commandHelpers.ts');
    let review: boolean | null;
    try {
      review = readYesNo('\nReview your Ballin preferences? [Y/n] ', true);
    } catch (error) {
      if (error instanceof CommandInterrupted) throw error;
      writeStderrLine(terminalError('Unable to read preference review input. Earlier installation changes remain.', process.stderr));
      writeStderrLine(`Run ${terminalCommand('ballin setup', process.stderr)} to review preferences.`);
      return false;
    }
    if (review === true) {
      generalReview = true;
      const { reviewGeneralPreferences } = require('./setup.ts');
      if (reviewGeneralPreferences(configPathFor(repoDir), { installation: true, deferFollowUp: true }) === 'failed') return false;
    }
  }

  setupAnalytics(repoDir);

  if (mode !== 'self-update') {
    const general = `Change preferences with ${terminalCommand('ballin setup')}.`;
    const backup = backupSetupCancelled ? `Run ${terminalCommand('ballin backup setup')} when you’re ready.`
      : backupFlow ? `Change backup settings with ${terminalCommand('ballin backup setup')}.`
      : `Run ${terminalCommand('ballin backup setup')} to configure or review your GitHub backup.`;
    const followUp = generalReview ? [general, backup] : backupFlow ? [backup, general] : [general];
    writeStdoutLine('\n' + terminalProse(followUp.join('\n')));
  }

  if (!configExisted && fs.existsSync(configPathFor(repoDir)) && mode !== 'fresh') {
    writeStdoutLine(terminalProse(`\ni Installation details: ${docsUrl}#what-will-installation-change`));
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
  createDefaultConfig,
  configureBackup,
  disconnectBackup,
  readOriginalSetupConfig,
  runInstallSetupCli,
  setup,
  setupAnalytics,
  symlinkBinaries,
};
