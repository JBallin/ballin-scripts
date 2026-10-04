const { validatedBackupSummary } = require('../commands/backup_summary.ts');

describe('validated backup summary', () => {
  const url = 'https://github.com/fixture-user/ballin-backups';
  it('reports absent sensitive consent and the bundled automatic-backup default without modifying config', () => {
    const config = Object.freeze({});
    assert.equal(validatedBackupSummary(url, config), `Validated private backup: ${url}\nSensitive sources: excluded\nAutomatic backup during update: disabled`);
    assert.equal(validatedBackupSummary(url, config, false), '');
    assert.deepEqual(config, {});
  });
  it('uses the bundled automatic-backup default for an absent leaf', () => {
    assert.include(validatedBackupSummary(url, { update: {} }), 'Automatic backup during update: disabled');
  });
});
