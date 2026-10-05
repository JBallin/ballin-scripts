const { formatDefaultDoctorReport, formatVerboseDoctorReport } = require('../commands/doctor_report.ts');

describe('doctor literal recovery guidance', () => {
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
});
