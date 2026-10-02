const { terminalEmphasis } = require('./terminalStyle.ts');
const {
  ensureAnalyticsInstallId,
  installIdPathForRepo,
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const path = require('path');
const { configPath, fetchConfig } = require('../config/index.ts');
const {
  runConfigCli,
} = require('../config/cli.ts');
const {
  runSelfUpdateCommand,
} = require('./self_update.ts');
const {
  runUninstallCommand,
} = require('./uninstall.ts');
const {
  collectSetupReadiness,
} = require('./setup_readiness.ts');
const {
  formatDefaultDoctorReport,
  formatVerboseDoctorReport,
} = require('./doctor_report.ts');
const {
  runBackupCommand,
} = require('./backup.ts');
const {
  runUpdateCommand,
} = require('./update.ts');
import type { TopLevelCommandName } from './top_level_commands.ts';
const {
  isTopLevelCommandName,
} = require('./top_level_commands.ts') as {
  isTopLevelCommandName: (value: unknown) => value is TopLevelCommandName;
};
import type { DoctorReport } from './doctor_report.ts';

const analyticsInstallIdPath = installIdPathForRepo(path.dirname(configPath));

const format = {
  fileName: terminalEmphasis('file name', 'underline'),
  key: terminalEmphasis('key', 'underline'),
  value: terminalEmphasis('value', 'underline'),
  get: terminalEmphasis('get', 'bold'),
  set: terminalEmphasis('set', 'bold'),
  setup: terminalEmphasis('setup', 'bold'),
  empty: terminalEmphasis("''", 'bold'),
  reset: terminalEmphasis('reset', 'bold'),
  open: terminalEmphasis('open', 'bold'),
  read: terminalEmphasis('read', 'bold'),
  verbose: terminalEmphasis('--verbose', 'bold'),
};

const examples = {
  get: '(ex: get update.cleanup)',
  set: '(ex: set update.cleanup false)',
};

const ballinHelp = `
Ballin
Back up your dotfiles and update your macOS development environment.
https://github.com/JBallin/ballin-scripts

Usage:

    ballin <command> [options]
    ballin --help

Commands:

    update                update the Ballin-managed macOS development environment
    backup                back up Ballin-managed environment state to the configured backup
                          ${format.setup} [repository-name] create or reconnect to an optional backup
                          sensitive sources: backup.includeSensitive (default: false)
                          ${format.open} open the configured backup
                          ${format.read} ${format.fileName} read a backed-up file
                          disconnect stop local backups and clear comparison state
    doctor                check whether the Ballin-managed environment is healthy
                          ${format.verbose} show full readiness details
    config                ${format.empty}/${format.get} view entire config
                          ${format.get} ${format.key} ${examples.get}
                          ${format.set} ${format.key} ${format.value} ${examples.set}
                          ${format.reset} (to defaults)
    self-update           update Ballin's local checkout, shims, and config
    uninstall             remove Ballin command shims and local checkout

Examples:

    ballin update
    ballin backup
    ballin doctor

`;
const updateHelp = `Usage:
    ballin update
    ballin update --help

Update the Ballin-managed macOS development environment.
Configured stages can update Homebrew, Node.js LTS, global npm packages,
macOS, and Ballin, then back up environment state.
Use ballin config get update to inspect settings.
`;

const backupHelp = `Usage:
    ballin backup
    ballin backup setup [repository-name]
    ballin backup open
    ballin backup read <file>
    ballin backup disconnect
    ballin backup --help

Back up Ballin-managed environment state to the configured backup.
setup creates or reconnects to an optional backup; open opens it in a browser.
read prints a backed-up file; disconnect stops local backups and clears comparison state.
Repository backups exclude sensitive sources unless backup.includeSensitive is true.
`;

const isCommandHelp = (args: string[]): boolean => (
  args.length === 2 && args[1] === '--help'
  && ['config', 'update', 'backup'].includes(args[0])
);

const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text);
};

const usageError = (usage: string): void => {
  writeStderr(`Usage: ${usage}\n`);
  process.exitCode = 2;
};

const runNoArgCommand = (usage: string, args: string[], command: () => void): void => {
  if (args.length > 0) {
    usageError(usage);
    return;
  }
  command();
};

const isAnalyticsPreferenceWrite = (args: string[]): boolean => (
  args.length === 4 && args[0] === 'config' && args[1] === 'set' && args[2] === 'analytics.enabled'
);

const repairAnalyticsInstallId = (analyticsConfig?: { enabled?: string }): void => {
  try {
    ensureAnalyticsInstallId({
      analyticsConfig: analyticsConfig ?? fetchConfig().configObj.analytics,
      env: process.env,
      installIdPath: analyticsInstallIdPath,
    });
  } catch {
    // Analytics identity repair must never affect command behavior.
  }
};

const runConfigCommand = (args: string[]): void => {
  runConfigCli(args);
  if (process.exitCode === 0 && args[0] === 'set' && args[1] === 'analytics.enabled' && args[2] === 'true') {
    repairAnalyticsInstallId({ enabled: 'true' });
  }
};

const runDoctorCommand = (args: string[]): void => {
  const verbose = args.length === 1 && args[0] === '--verbose';
  if (args.length > 0 && !verbose) {
    usageError('ballin doctor [--verbose]');
    return;
  }

  const repoDir = path.join(__dirname, '..');
  const report = collectSetupReadiness({
    repoDir,
    configPath: process.env.BALLIN_TEST_CONFIG_PATH || undefined,
    env: process.env,
  }) as DoctorReport;

  writeStdout(verbose ? formatVerboseDoctorReport(report) : formatDefaultDoctorReport(report));
  process.exitCode = report.status === 'fail' ? 1 : 0;
};

function runBallinCommand(args = process.argv.slice(2)): void {
  const [command, ...commandArgs] = args;

  switch (command) {
    case undefined:
    case '--help':
    case 'help':
      writeStdout(ballinHelp);
      return;
  }

  if (!isTopLevelCommandName(command)) {
    writeStderr(`Unknown Ballin command: ${command}\nTry: ballin --help\n`);
    process.exitCode = 2;
    return;
  }

  switch (command) {
    case 'update':
      if (isCommandHelp(args)) {
        writeStdout(updateHelp);
        return;
      }
      runNoArgCommand('ballin update', commandArgs, runUpdateCommand);
      return;
    case 'backup':
      if (isCommandHelp(args)) {
        writeStdout(backupHelp);
        return;
      }
      if (commandArgs.length === 1 && commandArgs[0] === 'help') {
        writeStdout(ballinHelp);
        return;
      }
      runBackupCommand(commandArgs);
      return;
    case 'doctor':
      runDoctorCommand(commandArgs);
      return;
    case 'config':
      runConfigCommand(commandArgs);
      return;
    case 'self-update':
      runNoArgCommand('ballin self-update', commandArgs, runSelfUpdateCommand);
      return;
    case 'uninstall':
      runNoArgCommand('ballin uninstall', commandArgs, runUninstallCommand);
      return;
    default: {
      const unhandledCommand: never = command;
      throw new Error(`Unhandled Ballin command: ${String(unhandledCommand)}`);
    }
  }
}

const analyticsCommandForBallinArgs = (args = process.argv.slice(2)): string => {
  const [command] = args;
  if (isTopLevelCommandName(command)) {
    return `ballin ${command}`;
  }
  return 'ballin';
};

const runBallinCli = (): void => {
  const args = process.argv.slice(2);
  if (isCommandHelp(args)) {
    runBallinCommand(args);
    return;
  }
  if (!isAnalyticsPreferenceWrite(args)) {
    repairAnalyticsInstallId();
  }
  const analyticsRuntime = isAnalyticsPreferenceWrite(args)
    ? { analyticsConfig: { enabled: 'false' }, installIdPath: analyticsInstallIdPath }
    : { installIdPath: analyticsInstallIdPath, preserveLocalState: args[0] === 'uninstall' };
  void runWithCommandAnalytics(
    analyticsCommandForBallinArgs(args),
    () => runBallinCommand(args),
    analyticsRuntime,
  ).catch(rethrowCommandError);
};

module.exports = {
  analyticsCommandForBallinArgs,
  runBallinCli,
};
