const { formatDefaultDoctorReport, formatVerboseDoctorReport } = require('../commands/doctor_report.ts');
const { repositoryMessages, formatRepositoryMessage } = require('../commands/backup_repository.ts');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('doctor literal recovery guidance', () => {
  it('retains the selected custom host in authentication guidance', () => {
    const report = { status: 'fail', checks: [{ id: 'backup.read', label: 'Backup', status: 'fail',
      summary: formatRepositoryMessage('authentication', {}, 'git.example.com') }] };
    for (const formatted of [formatDefaultDoctorReport(report), formatVerboseDoctorReport(report)]) {
      assert.include(formatted, 'gh auth login --hostname git.example.com');
      assert.notInclude(formatted, 'github.com');
    }
  });
  const cases = {
    'config.read': 'Run `ballin config reset` to recreate the config.',
    'backup.read': 'Resolve the reported error, then rerun `ballin doctor`. Use `ballin backup setup` to revalidate the selected backup if needed.',
    'backup.config': 'Run `ballin backup disconnect`, then `ballin backup setup` to select a private repository.',
    'backup.consent': 'Set `backup.includeSensitive` to true or false; read-only recovery remains available.',
  };
  Object.entries(cases).forEach(([id, guidance]) => {
    it(`marks literals in ${id} guidance without terminal styling`, () => {
      const report = { status: 'fail', checks: [{ id, label: 'Check', status: 'fail', summary: 'Needs attention.' }] };
      assert.equal(formatDefaultDoctorReport(report), `ERROR Check: Needs attention.\nNext: ${guidance}\n`);
      assert.equal(formatVerboseDoctorReport(report), `Ballin doctor\n\nERROR Check: Needs attention.\n      Next: ${guidance}\n\nResult: Ballin-managed environment has errors.\n`);
    });
  });
  it('separates multiple problems and their next steps into compact groups', () => {
    const report = { status: 'fail', checks: [
      { id: 'config.read', label: 'Config', status: 'fail', summary: 'Unreadable.' },
      { id: 'backup.read', label: 'Backup', status: 'warn', summary: 'Unavailable.' },
    ] };
    assert.equal(formatDefaultDoctorReport(report), 'ERROR Config: Unreadable.\nNext: Run `ballin config reset` to recreate the config.\n\nWARN  Backup: Unavailable.\nNext: Resolve the reported error, then rerun `ballin doctor`. Use `ballin backup setup` to revalidate the selected backup if needed.\n');
  });

  for (const mode of [
    { name: 'capable TTY', tty: true, env: {}, styled: true },
    { name: 'redirected output', tty: false, env: { FORCE_COLOR: '1' }, styled: false },
    { name: 'dumb terminal', tty: true, env: { TERM: 'dumb', FORCE_COLOR: '1' }, styled: false },
    { name: 'nonempty NO_COLOR', tty: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' }, styled: false },
    { name: 'NO_COLOR zero', tty: true, env: { NO_COLOR: '0' }, styled: false },
    { name: 'empty NO_COLOR', tty: true, env: { NO_COLOR: '' }, styled: true },
  ]) {
    it(`formats actual repository summaries in both reports on ${mode.name} without changing readiness data`, () => {
      const script = `
        Object.defineProperty(process.stdout, 'isTTY', {value:${mode.tty}});
        const {formatDefaultDoctorReport, formatVerboseDoctorReport} = require(${JSON.stringify(require.resolve('../commands/doctor_report.ts'))});
        const {repositoryMessages} = require(${JSON.stringify(require.resolve('../commands/backup_repository.ts'))});
        const messagesBefore = JSON.stringify(repositoryMessages);
        const results = ['authentication', 'resource-limit'].map(problem => {
          const report = {status:'fail', checks:[{id:'backup.read', label:'Private backup readiness', status:'fail', summary:repositoryMessages[problem]}]};
          const before = JSON.stringify(report);
          return {problem, default:formatDefaultDoctorReport(report), verbose:formatVerboseDoctorReport(report), unchanged:JSON.stringify(report) === before};
        });
        process.stdout.write(JSON.stringify({results, messagesUnchanged:JSON.stringify(repositoryMessages) === messagesBefore}));
      `;
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8',
        env: testChildEnvironment({ TERM: 'xterm', ...mode.env }) });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.isTrue(output.messagesUnchanged);
      const command = (text: string) => mode.styled ? `\x1b[1m${text}\x1b[0m` : `\`${text}\``;
      const next = `Resolve the reported error, then rerun ${command('ballin doctor')}. Use ${command('ballin backup setup')} to revalidate the selected backup if needed.`;
      for (const item of output.results) {
        assert.isTrue(item.unchanged);
        const reference = item.problem === 'authentication' ? 'gh auth login --hostname github.com' : 'ballin backup open';
        const summary = repositoryMessages[item.problem].replace(`\`${reference}\``, command(reference));
        assert.equal(item.default, `ERROR Private backup readiness: ${summary}\nNext: ${next}\n`);
        assert.equal(item.verbose, `Ballin doctor\n\nERROR Private backup readiness: ${summary}\n      Next: ${next}\n\nResult: Ballin-managed environment has errors.\n`);
      }
    });
  }
});
