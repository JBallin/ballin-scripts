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

  const visibleStatus = report.status === 'fail' ? 'fail' : 'warn';
  const visibleChecks = report.checks.filter(({ status }) => status === visibleStatus);
  return `${visibleChecks.map((check) => formatDoctorCheck(check, 'Next: ')).join('\n')}\n`;
};

module.exports = {
  formatDefaultDoctorReport,
  formatVerboseDoctorReport,
};

export type {
  DoctorCheck,
  DoctorReport,
  DoctorStatus,
};
