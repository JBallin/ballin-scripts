const { backupCommitMessage } = require('../commands/backup_commit_message.ts');
const { snapshotDefinitions } = require('../commands/backup_snapshots.ts');
import type { SnapshotDefinition } from '../commands/backup_snapshots.ts';

describe('backup commit messages', () => {
  it('describes one source without a redundant body', () => {
    assert.deepEqual(backupCommitMessage(['codex_config.toml']), { headline: 'Update: Codex config' });
  });
  it('uses stable catalog order and deduplicates paths', () => {
    const expected = { headline: 'Update: Zsh settings, Git config' };
    assert.deepEqual(backupCommitMessage(['gitconfig', 'zshrc.sh', 'gitconfig']), expected);
    assert.deepEqual(backupCommitMessage(['zshrc.sh', 'gitconfig']), expected);
  });
  it('fits a readable full list without a fixed source-count cutoff', () => {
    assert.deepEqual(backupCommitMessage(['vimrc', 'nvmrc', 'gitconfig', 'Brewfile']), {
      headline: 'Update: Brewfile, Git config, Node version, Vim settings',
    });
  });
  it('shortens by subject length and includes the complete list only then', () => {
    assert.deepEqual(backupCommitMessage(['vsI_settings', 'vsI_keybindings', 'vsI_extensions']), {
      headline: 'Update: VS Code Insiders settings, VS Code Insiders keybindings, +1 more',
      body: 'Changed sources:\n- VS Code Insiders settings (vsI_settings)\n'
        + '- VS Code Insiders keybindings (vsI_keybindings)\n- VS Code Insiders extensions (vsI_extensions)',
    });
  });
  it('uses a compact count when only one source is omitted', () => {
    assert.deepEqual(backupCommitMessage(['bash_profile.sh', 'vsI_settings', 'vsI_keybindings']), {
      headline: 'Update: Bash profile, VS Code Insiders settings, +1 more',
      body: 'Changed sources:\n- Bash profile (bash_profile.sh)\n'
        + '- VS Code Insiders settings (vsI_settings)\n- VS Code Insiders keybindings (vsI_keybindings)',
    });
  });
  it('includes subjects of exactly 72 characters without a body', () => {
    const result = backupCommitMessage(['bashrc.sh', 'vs_keybindings', 'vsI_keybindings']);
    assert.equal(result.headline.length, 72);
    assert.notProperty(result, 'body');
  });
  it('shortens a full subject of 73 characters', () => {
    assert.deepEqual(backupCommitMessage(['bash_completions', 'brew_list', 'vsI_keybindings']), {
      headline: 'Update: Bash completions, Homebrew formulae, +1 more',
      body: 'Changed sources:\n- Bash completions (bash_completions)\n'
        + '- Homebrew formulae (brew_list)\n- VS Code Insiders keybindings (vsI_keybindings)',
    });
  });
  it('bounds the full catalog subject and lists each changed source exactly once', () => {
    const names = (snapshotDefinitions as readonly SnapshotDefinition[]).map(({ name }) => name);
    const result = backupCommitMessage(names);
    assert.isAtMost(result.headline.length, 72);
    assert.equal(result.body.split('\n').length, names.length + 1);
    for (const name of names) assert.include(result.body, `(${name})`);
    assert.notInclude(result.body, 'backup source (');
    assert.deepEqual(backupCommitMessage(names.toReversed()), result);
    for (const name of names) {
      const single = backupCommitMessage([name]);
      assert.isAtMost(single.headline.length, 72);
      assert.notProperty(single, 'body');
      assert.notEqual(single.headline, 'Update: backup source');
    }
  });
  it('maps removed paths without reading source files or leaking arbitrary names', () => {
    assert.deepEqual(backupCommitMessage(['codex_rules.bundle.json']), { headline: 'Update: Codex rules' });
    const unknown = 'PRIVATE_FILENAME\nsecret=PRIVATE_VALUE';
    assert.deepEqual(backupCommitMessage([unknown]), { headline: 'Update: other sources' });
    const result = backupCommitMessage(['vsI_keybindings', 'codex_AGENTS.override.md', unknown]);
    assert.include(result.body, '- Other sources');
    assert.notInclude(JSON.stringify(result), 'PRIVATE');
  });
  it('uses an appropriate generic fallback without known changes', () => {
    assert.deepEqual(backupCommitMessage([]), { headline: 'Update: backup sources' });
  });
});
