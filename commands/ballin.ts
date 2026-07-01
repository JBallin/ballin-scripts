const {
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const path = require('path');
const {
  collectSetupReadiness,
} = require('./setup_readiness.ts');
const {
  formatDefaultDoctorReport,
  formatVerboseDoctorReport,
} = require('./doctor_report.ts');
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
A Collection of Ballin Scripts!
https://github.com/JBallin/ballin-scripts

Commands:

    ballin_update         update to latest version
    ballin_config         ${format.empty}/${format.get} view entire config
                          ${format.get} ${format.key} ${examples.get}
                          ${format.set} ${format.key} ${format.value} ${examples.set}
                          ${format.reset} (to defaults)
    ballin_uninstall      remove ballin-scripts
    ballin doctor         check Ballin-managed environment health
                          ${format.verbose} show full readiness details

Scripts:

    gu                    gist: ${format.empty} (update), ${format.open}, ${format.read} ${format.fileName}
    up                    update brew etc.

`;
const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text);
};

const runDoctorCommand = (args: string[]): void => {
  const verbose = args.length === 1 && args[0] === '--verbose';
  if (args.length > 0 && !verbose) {
    writeStderr('Usage: ballin doctor [--verbose]\n');
    process.exitCode = 2;
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
  if (args[0] === 'doctor') {
    runDoctorCommand(args.slice(1));
    return;
  }

  writeStdout(ballinHelp);
}

const runBallinCli = (): void => {
  void runWithCommandAnalytics('ballin', runBallinCommand).catch(rethrowCommandError);
};

module.exports = {
  runBallinCli,
};
