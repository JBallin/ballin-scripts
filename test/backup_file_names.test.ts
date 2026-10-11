const { compareBackupFileNames } = require('../commands/backup_file_names.ts');

describe('backup filename order', () => {
  it('compares filenames case-insensitively and keeps Brewfile before brew inventories', () => {
    assert.deepEqual(['zshrc.sh', 'vsI_settings', 'vs_settings', 'brew_list', 'Brewfile', 'brew_cask']
      .toSorted(compareBackupFileNames), ['Brewfile', 'brew_cask', 'brew_list', 'vs_settings', 'vsI_settings', 'zshrc.sh']);
    assert.equal(compareBackupFileNames('vsI_settings', 'vsi_SETTINGS'), 0);
  });
});
