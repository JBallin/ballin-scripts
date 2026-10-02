const { formatDefaultDoctorReport, formatVerboseDoctorReport } = require('../commands/doctor_report.ts');

describe('doctor literal recovery guidance', () => {
  const cases = {
    'config.read': 'Run `ballin config reset` to recreate the config.',
    'backup.host': 'Run `ballin backup setup` to repair the backup host.',
    'backup.gist': 'Run `ballin config reset` to restore valid defaults, then run `ballin backup setup` if needed.',
    'backup.auth': 'Run `gh auth login` for the configured backup host.',
    'backup.read': 'Check access to the selected backup, then run `ballin backup setup` to revalidate it.',
    'backup.config': 'Repair the selected backup configuration or run `ballin backup disconnect`.',
    'backup.consent': 'Set `backup.includeSensitive` to true or false; read-only recovery remains available.',
  };
  Object.entries(cases).forEach(([id, guidance]) => {
    it(`marks literals in ${id} guidance without terminal styling`, () => {
      const report = { status: 'fail', checks: [{ id, label: 'Check', status: 'fail', summary: 'Needs attention.' }] };
      assert.equal(formatDefaultDoctorReport(report), `ERROR Check: Needs attention.\nNext: ${guidance}\n`);
      assert.equal(formatVerboseDoctorReport(report), `Ballin doctor\n\nERROR Check: Needs attention.\n      Next: ${guidance}\n\nResult: Ballin-managed environment has errors.\n`);
    });
  });
});
