const {
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const path = require('path');
const {
  runConfigCli,
} = require('../config/cli.ts');
const {
  runBallinUpdateCommand,
} = require('./ballin_update.ts');
const {
  runBallinUninstallCli,
} = require('./ballin_uninstall.ts');
const {
  collectSetupReadiness,
} = require('./setup_readiness.ts');
const {
  formatDefaultDoctorReport,
  formatVerboseDoctorReport,
} = require('./doctor_report.ts');
const {
  runGuCommand,
} = require('./gu.ts');
const {
  runUpCommand,
} = require('./up.ts');
import type { DoctorReport } from './doctor_report.ts';

const format = {
  fileName: '\x1b[4mfile name\x1b[0m',
  key: '\x1b[4mkey\x1b[0m',
  value: '\x1b[4mvalue\x1b[0m',
  get: '\x1b[1mget\x1b[0m',
  set: '\x1b[1mset\x1b[0m',
  empty: "\x1b[1m''\x1b[0m",
  reset: '\x1b[1mreset\x1b[0m',
  open: '\x1b[1mopen\x1b[0m',
  read: '\x1b[1mread\x1b[0m',
  verbose: '\x1b[1m--verbose\x1b[0m',
};

const examples = {
  get: '(ex: get up.cleanup)',
  set: '(ex: set up.cleanup true)',
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
    backup                backup Ballin-managed environment state to the configured private Gist
                          ${format.open} open the configured backup Gist
                          ${format.read} ${format.fileName} read a backed-up file
    doctor                check whether the Ballin-managed environment is healthy
                          ${format.verbose} show full readiness details
    config                ${format.empty}/${format.get} view entire config
                          ${format.get} ${format.key} ${examples.get}
                          ${format.set} ${format.key} ${format.value} ${examples.set}
                          ${format.reset} (to defaults)
    self-update           update Ballin's local checkout, shims, and config
    uninstall             remove Ballin command shims and local checkout

Shortcuts:

    up                    same as: ballin update
    gu                    same as: ballin backup

Examples:

    ballin update
    ballin backup
    ballin doctor
    up
    gu

`;
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
    case 'update':
      runNoArgCommand('ballin update', commandArgs, runUpCommand);
      return;
    case 'backup':
      runGuCommand(commandArgs);
      return;
    case 'doctor':
      runDoctorCommand(commandArgs);
      return;
    case 'config':
      runConfigCli(commandArgs);
      return;
    case 'self-update':
      runNoArgCommand('ballin self-update', commandArgs, runBallinUpdateCommand);
      return;
    case 'uninstall':
      runNoArgCommand('ballin uninstall', commandArgs, runBallinUninstallCli);
      return;
    default:
      writeStderr(`Unknown Ballin command: ${command}\nTry: ballin --help\n`);
      process.exitCode = 2;
  }
}

const runBallinCli = (): void => {
  void runWithCommandAnalytics('ballin', runBallinCommand).catch(rethrowCommandError);
};

module.exports = {
  runBallinCli,
};
