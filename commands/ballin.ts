const { formatHelp } = require('./help_format.ts');
const { terminalCommand, terminalCommandReferences } = require('./terminalStyle.ts');
const { withTemporaryStatus } = require('./temporaryStatus.ts');
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
  isConfigHelp,
} = require('../config/cli.ts');
const { isConfigOperationName } = require('../config/commands.ts');
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
import type { BackupCommandName } from './backup_commands.ts';
const { isBackupCommandName } = require('./backup_commands.ts') as {
  isBackupCommandName: (value: unknown) => value is BackupCommandName;
};
const {
  runUpdateCommand,
} = require('./update.ts');
import type { TopLevelCommandName } from './top_level_commands.ts';
const {
  isTopLevelCommandName,
  commandHelpOptionName,
  doctorVerboseOptionName,
} = require('./top_level_commands.ts') as {
  isTopLevelCommandName: (value: unknown) => value is TopLevelCommandName;
  commandHelpOptionName: string;
  doctorVerboseOptionName: string;
};
import type { DoctorReport } from './doctor_report.ts';

const analyticsInstallIdPath = installIdPathForRepo(path.dirname(configPath));

const ballinHelp = `Ballin
Back up your dotfiles and update your macOS development environment.

Usage:
    ballin <command> [options]
    ballin help [command...]

Commands:
    update                update configured tools and run enabled backups
    backup                back up Ballin-managed environment state
    doctor                check tools, configuration, and backup readiness
    config                view or change Ballin configuration
    setup                 review local backup and analytics preferences
    self-update           update Ballin itself
    uninstall             remove Ballin

Run \`ballin help <command...>\` for command or subcommand help.
You can also append \`--help\` to a command.

🔗 Project and documentation:
https://github.com/JBallin/ballin-scripts
`;
const updateHelp = `Usage:
    ballin update

Update the Ballin-managed macOS development environment. Configured stages can update Homebrew, Node.js LTS, global npm packages, macOS, and Ballin, then back up environment state. Use \`ballin config get update\` to inspect settings.
`;

const backupHelp = `Usage:
    ballin backup
    ballin backup <command>

Back up Ballin-managed environment state to the configured backup.

Commands:
    setup                 create, reconnect to, or validate a backup
    open                  open the backup and its history in a browser
    list                  list supported saved snapshots
    read                  print a snapshot or inspect files in a bundle
    disconnect            disconnect this Mac and disable automatic backups

Repository backups include only locally approved sensitive sources; review them with \`ballin setup\`. Run \`ballin help backup <subcommand>\` for subcommand-specific help.
`;

const backupSubcommandHelp: Record<BackupCommandName, string> = {
  setup: `Usage:
    ballin backup setup [repository-name] [--hostname <host>]

Create, reconnect to, or validate a private GitHub backup repository owned by your account.

New setup: Choose Create or Reconnect. Omit the repository name to choose it during setup. Choose whether to include sensitive sources, confirm the destination, then choose whether updates should run backups automatically.

Existing backup: Validate the saved repository and review backup preferences. The saved host is retained; disconnect before choosing a different destination. For local backup and analytics preferences, use \`ballin setup\`.

New setup asks for a GitHub hostname (default: github.com); \`--hostname <host>\` skips that question. Use a hostname, not a URL. Authenticate gh for the selected host before setup.

🔗 Setup and recovery:
https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#optional-backup-setup-and-reconnect

🔗 Backup sources and sensitivity:
https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md
`,
  open: `Usage:
    ballin backup open

Open the configured backup in your browser, including its saved history. Requires authentication for the selected GitHub host and remote access.
`,
  list: `Usage:
    ballin backup list

List supported snapshots saved in the configured backup. Requires remote read access; does not collect local backup sources.
`,
  read: `Usage:
    ballin backup read <snapshot>
    ballin backup read <snapshot> --list
    ballin backup read <snapshot> --file <path>

Print a supported saved snapshot's original bytes without restoring or executing it. Requires remote read access. Use \`ballin backup list\` to find snapshot names.

For bundle snapshots, \`--list\` lists saved files; \`--file <path>\` prints one file's original bytes. Without a snapshot selector, report the missing argument and list saved options when readable.

Examples:
    ballin backup read zshrc.sh
    ballin backup read codex_skills.bundle.json --list
    ballin backup read codex_skills.bundle.json --file example/SKILL.md

🔗 Inspect saved backups:
https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#inspect-saved-backups
`,
  disconnect: `Usage:
    ballin backup disconnect

Clear local backup linkage and comparison state, and disable automatic backup during updates. Preserve remote history, shared GitHub CLI authentication, and sensitive-source preferences. Requires no authentication or network access.
`,
};

const doctorHelp = `Usage:
    ballin doctor [--verbose]

Check whether the Ballin-managed environment is healthy. Use \`--verbose\` to show full readiness details.
`;

const selfUpdateHelp = `Usage:
    ballin self-update

Update the local \`ballin-scripts\` checkout, command shims, and configuration.
`;

const uninstallHelp = `Usage:
    ballin uninstall

Remove Ballin-owned command links and the local \`ballin-scripts\` checkout.

🔗 Removal details:
https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#uninstall
`;

const isCommandHelp = (args: string[]): boolean => (
  args.length === 2 && args[1] === commandHelpOptionName
  && isTopLevelCommandName(args[0])
);

const backupHelpCommand = (args: string[]): BackupCommandName | undefined => (
  args.length === 3 && args[0] === 'backup' && isBackupCommandName(args[1])
    && args[2] === commandHelpOptionName ? args[1] : undefined
);

const isPositionalHelp = (args: string[]): boolean => (
  args.length === 2 && ['backup', 'config'].includes(args[0]) && args[1] === 'help'
);

const isConfigCommandHelp = (args: string[]): boolean => (
  args[0] === 'config' && isConfigHelp(args.slice(1))
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
  const verbose = args.length === 1 && args[0] === doctorVerboseOptionName;
  if (args.length > 0 && !verbose) {
    usageError('ballin doctor [--verbose]');
    return;
  }

  const repoDir = path.join(__dirname, '..');
  const report = withTemporaryStatus('Checking readiness...', () => collectSetupReadiness({
    repoDir,
    configPath: process.env.BALLIN_TEST_CONFIG_PATH || undefined,
    env: process.env,
  }) as DoctorReport);

  writeStdout(verbose ? formatVerboseDoctorReport(report) : formatDefaultDoctorReport(report));
  process.exitCode = report.status === 'fail' ? 1 : 0;
};

function runBallinCommand(args = process.argv.slice(2)): void {
  const [command, ...commandArgs] = args;

  switch (command) {
    case undefined:
    case commandHelpOptionName:
    case 'help':
      writeStdout(terminalCommandReferences(formatHelp(ballinHelp), ['ballin help <command...>']));
      return;
  }

  if (!isTopLevelCommandName(command)) {
    writeStderr(`Unknown Ballin command: ${command}\nTry: ${terminalCommand('ballin help', process.stderr)}\n`);
    process.exitCode = 2;
    return;
  }

  switch (command) {
    case 'update':
      if (isCommandHelp(args)) {
        writeStdout(terminalCommandReferences(formatHelp(updateHelp), ['ballin config get update']));
        return;
      }
      runNoArgCommand('ballin update', commandArgs, runUpdateCommand);
      return;
    case 'backup': {
      if (isCommandHelp(args)) {
        writeStdout(terminalCommandReferences(formatHelp(backupHelp), ['ballin setup', 'ballin help backup <subcommand>']));
        return;
      }
      if (commandArgs.length === 1 && commandArgs[0] === 'help') {
        writeStdout(terminalCommandReferences(formatHelp(backupHelp), ['ballin setup', 'ballin help backup <subcommand>']));
        return;
      }
      const helpCommand = backupHelpCommand(args);
      if (helpCommand !== undefined) {
        writeStdout(terminalCommandReferences(formatHelp(backupSubcommandHelp[helpCommand]), ['ballin setup', 'ballin backup list']));
        return;
      }
      runBackupCommand(commandArgs);
      return;
    }
    case 'doctor':
      if (isCommandHelp(args)) {
        writeStdout(formatHelp(doctorHelp));
        return;
      }
      runDoctorCommand(commandArgs);
      return;
    case 'config':
      runConfigCommand(commandArgs);
      return;
    case 'setup':
      if (commandArgs.length === 1 && commandArgs[0] === commandHelpOptionName) {
        writeStdout(terminalCommandReferences(formatHelp(setupHelp), ['ballin backup setup']));
        return;
      }
      runNoArgCommand('ballin setup', commandArgs, () => {
        runSetupCommand();
        if (process.exitCode === 0) repairAnalyticsInstallId();
      });
      return;
    case 'self-update':
      if (isCommandHelp(args)) {
        writeStdout(formatHelp(selfUpdateHelp));
        return;
      }
      runNoArgCommand('ballin self-update', commandArgs, runSelfUpdateCommand);
      return;
    case 'uninstall':
      if (isCommandHelp(args)) {
        writeStdout(formatHelp(uninstallHelp));
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
  let args = process.argv.slice(2);
  if (args[0] === 'help') {
    if (args.length === 2 && isTopLevelCommandName(args[1])) {
      args = [args[1], commandHelpOptionName];
    } else if (args.length === 3 && ((args[1] === 'backup' && isBackupCommandName(args[2]))
      || (args[1] === 'config' && isConfigOperationName(args[2])))) {
      args = [args[1], args[2], commandHelpOptionName];
    }
  }
  if (args.length === 0 || (args.length === 1 && ['help', commandHelpOptionName].includes(args[0]))
    || isCommandHelp(args) || backupHelpCommand(args) !== undefined || isPositionalHelp(args) || isConfigCommandHelp(args)) {
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
