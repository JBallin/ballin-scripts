const {
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const path = require('path');
const {
  collectSetupReadiness,
} = require('./setup_readiness.ts');

type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';
type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  summary: string;
};
type DoctorReport = {
  status: Exclude<DoctorStatus, 'info'>;
  checks: DoctorCheck[];
};

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
const statusLabels: Record<DoctorStatus, string> = {
  pass: 'OK',
  warn: 'WARN',
  fail: 'ERROR',
  info: 'INFO',
};

const nextSteps: Record<string, string> = {
  'runtime.node': 'Install a supported Node.js version and reopen your shell.',
  'commands.path': 'Run the installer again or add the Ballin command directory to PATH.',
  'config.read': 'Recreate ballin.config.json from config/.defaultConfig.json.',
  'gu.host': 'Set the backup host with ballin_config set gu.host <host>.',
  'gu.gist': 'Run the installer to create or adopt a backup Gist.',
  'gu.gh': 'Install GitHub CLI and authenticate it for your backup host.',
  'gu.auth': 'Run gh auth login for the configured backup host.',
};

const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text);
};

const formatDoctorCheck = (check: DoctorCheck, nextPrefix = '      Next: '): string => {
  const lines = [
    `${statusLabels[check.status].padEnd(5)} ${check.label}: ${check.summary}`,
  ];
  if (check.status === 'warn' || check.status === 'fail') {
    lines.push(`${nextPrefix}${nextSteps[check.id] ?? 'Review the check output above.'}`);
  }
  return lines.join('\n');
};

const formatVerboseDoctorReport = (report: DoctorReport): string => {
  const statusSummary = report.status === 'pass'
    ? 'Ballin-managed environment health looks good.'
    : report.status === 'warn'
      ? 'Ballin-managed environment has warnings. Warnings do not fail this command.'
      : 'Ballin-managed environment has errors.';

  return [
    'Ballin doctor',
    '',
    ...report.checks.map((check) => formatDoctorCheck(check)),
    '',
    `Result: ${statusSummary}`,
    '',
  ].join('\n');
};

const formatDefaultDoctorReport = (report: DoctorReport): string => {
  if (report.status === 'pass') {
    return 'Your Ballin-managed environment is healthy.\n';
  }

  const visibleStatuses = report.status === 'fail' ? ['fail', 'warn'] : ['warn'];
  const visibleChecks = report.checks.filter(({ status }) => visibleStatuses.includes(status));
  return `${visibleChecks.map((check) => formatDoctorCheck(check, 'Next: ')).join('\n')}\n`;
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
