const { terminalEmphasis } = require('./terminalStyle.ts');
const {
  ensureAnalyticsInstallId,
  installIdPathForRepo,
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const path = require('path');
const { runSetupCommand, setupHelp } = require('./setup.ts');
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

const ballinHelp = `
Ballin
Back up your dotfiles and update your macOS development environment.
https://github.com/JBallin/ballin-scripts

Usage:

    ballin <command> [options]
    ballin --help

Commands:

    update                update the Ballin-managed macOS development environment
    backup                back up Ballin-managed environment state
    doctor                check whether the Ballin-managed environment is healthy
    config                view or change Ballin configuration
    setup                 review local onboarding preferences
    self-update           update Ballin itself
    uninstall             remove Ballin

Run \`${terminalEmphasis('ballin <command> --help', 'bold')}\` for command-specific help.

`;
const updateHelp = `Usage:
    ballin update
    ballin update --help

Update the Ballin-managed macOS development environment.
Configured stages can update Homebrew, Node.js LTS, global npm packages,
macOS, and Ballin, then back up environment state.
Use \`ballin config get update\` to inspect settings.
`;

const backupHelp = `Usage:
    ballin backup
    ballin backup setup [repository-name]
    ballin backup open
    ballin backup read <file>
    ballin backup disconnect
    ballin backup --help

Back up Ballin-managed environment state to the configured backup.
\`setup\` creates or reconnects to an optional backup; \`open\` opens it in a browser.
\`read\` prints a backed-up file; \`disconnect\` stops local backups and clears comparison state.
Repository backups include only locally approved sensitive sources; review them with \`ballin setup\`.
`;

const doctorHelp = `Usage:
    ballin doctor [--verbose]
    ballin doctor --help

Check whether the Ballin-managed environment is healthy.
Use \`--verbose\` to show full readiness details.
`;

const selfUpdateHelp = `Usage:
    ballin self-update
    ballin self-update --help

Update the local \`ballin-scripts\` checkout, command shims, and configuration.
`;

const uninstallHelp = `Usage:
    ballin uninstall
    ballin uninstall --help

Remove Ballin-owned command links and the local \`ballin-scripts\` checkout.
`;

const isCommandHelp = (args: string[]): boolean => (
  args.length === 2 && args[1] === '--help'
  && isTopLevelCommandName(args[0])
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
      if (isCommandHelp(args)) {
        writeStdout(doctorHelp);
        return;
      }
      runDoctorCommand(commandArgs);
      return;
    case 'config':
      runConfigCommand(commandArgs);
      return;
    case 'setup':
      if (commandArgs.length === 1 && commandArgs[0] === '--help') {
        writeStdout(setupHelp);
        return;
      }
      runNoArgCommand('ballin setup', commandArgs, () => {
        runSetupCommand();
        if (process.exitCode === 0) repairAnalyticsInstallId();
      });
      return;
    case 'self-update':
      if (isCommandHelp(args)) {
        writeStdout(selfUpdateHelp);
        return;
      }
      runNoArgCommand('ballin self-update', commandArgs, runSelfUpdateCommand);
      return;
    case 'uninstall':
      if (isCommandHelp(args)) {
        writeStdout(uninstallHelp);
        return;
      }
      runNoArgCommand('ballin uninstall', commandArgs, runUninstallCommand);
      return;
    // The name guard and exhaustive cases reject all external unknown commands above.
    // Retain this fail-safe for future dispatcher edits; reaching it needs an invalid internal command union.
    /* c8 ignore next 4 */
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
  if (args.length === 0 || (args.length === 1 && ['help', '--help'].includes(args[0])) || isCommandHelp(args)) {
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
