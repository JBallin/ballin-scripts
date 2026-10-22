const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { selectScenario } = require('./helpers/sandbox_scenarios.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('interactive setup with delayed terminal answers', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  afterEach(() => { if (sandbox && fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });

  const backupAnswers = [
    { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'y' },
    { prompt: 'Reconnect to an existing backup or create a new one? [reconnect/create] ', answer: 'create' },
    { prompt: 'Repository name [ballin-backups]: ', answer: 'interactive-test' },
    { prompt: 'Review files that may contain credentials or private information for backup inclusion? [y/N] ', answer: 'y' },
    { prompt: 'private GitHub backup ', answer: 'y' },
    { prompt: 'Automatically run `ballin backup` as part of `ballin update`? [y/N] ', answer: 'y' },
  ];
  const assertInitializedOnly = (): void => {
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.deepEqual(config.backup.repository, { id: 'R_fixture', ownerId: 'U_fixture', name: 'interactive-test', branch: 'main' });
    assert.equal(config.backup.includeSensitive, 'true');
    assert.equal(config.update.backup, 'true');
    const remote = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
    assert.lengthOf(remote.requests.filter((request: { endpoint: string }) => request.endpoint === 'user/repos'), 1);
    assert.deepEqual(Object.keys(remote.commits[remote.head].files).sort(), ['.ballin-backup.json', 'README.md']);
    assert.isFalse(remote.requests.some((request: { endpoint: string }) => request.endpoint === 'open'));
    assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.backup-cache')));
    assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.analytics/install-id')));
    assert.notInclude(fs.readFileSync(sandbox.log, 'utf8'), 'softwareupdate:');
  };

  for (const shell of ['bash', 'zsh'] as const) {
    it(`waits through real quickstart analytics, completion, and optional backup setup (${shell})`, () => {
      sandbox = createSandbox({ quickstart: true });
      const startup = shell === 'bash'
        ? { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' }
        : { prompt: 'Zsh settings directory [', answer: '' };
      const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
        { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'yes' },
        startup,
        { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
        { prompt: 'and make the ballin command available? [y/N] ', answer: 'y' },
        { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
        { prompt: 'Enable tab completion in ', answer: 'y' },
        ...backupAnswers.slice(1),
        { prompt: 'Run a backup now and open its GitHub destination? [Y/n] ', answer: 'n' },
      ], shell);
      assert.isUndefined(result.error, result.stderr);
      assert.include(result.stdout, '\x1b[1;34m==>\x1b[1;39m Setting up Ballin\x1b[0m');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.split(startup.prompt).length - 1, 1, 'Reuse the selected location without repeating its question');
      assert.notInclude(result.stdout, 'Tab completion enabled.');
      assert.notInclude(result.stdout, 'Usage analytics:');
      const terminalGuidance = '😎 Setup complete! Open a new Terminal and run `ballin help`.';
      const firstBackupPrompt = 'Run a backup now and open its GitHub destination? [Y/n] ';
      assert.equal(result.stdout.split(terminalGuidance).length - 1, 1);
      assert.isBelow(result.stdout.indexOf('Private backup created:'), result.stdout.indexOf(firstBackupPrompt));
      assert.isBelow(result.stdout.indexOf(firstBackupPrompt), result.stdout.indexOf(terminalGuidance));
      assert.include(result.stdout.replace(/\r\n/gu, '\n'), firstBackupPrompt + 'n\n\n' + terminalGuidance + '\n');
      assert.notInclude(result.stdout, 'Continue setup here');
      assert.notInclude(result.stdout, 'Tools are ready for this setup.');
      assert.notInclude(result.stdout, 'PATH line added');
      assert.notInclude(result.stdout, 'Backup setup complete.');
      assert.notInclude(result.stdout, 'Unable to prepare backup configuration.');
      assert.notInclude(result.stdout, 'Tab completion setup could not finish.');
      assert.include(fs.readFileSync(path.join(sandbox.home, shell === 'bash' ? '.bash_profile' : '.zshrc'), 'utf8'),
        shell === 'bash' ? 'completions/ballin.bash' : 'completions/_ballin');
      assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8')).analytics.enabled, 'false');
      assertInitializedOnly();
    });
  }

  for (const shell of ['bash', 'zsh'] as const) {
    for (const acceptBackup of [false, true]) {
      it(`ends with the PATH reminder after backup ${acceptBackup ? 'acceptance' : 'decline'} (${shell})`, () => {
        sandbox = createSandbox({ quickstart: true });
        const startup = shell === 'bash'
          ? { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' }
          : { prompt: 'Zsh settings directory [', answer: '' };
        const backupSetup = backupAnswers.slice(1, 4).map(a => ({ ...a, answer: a.prompt.startsWith('Review ') ? 'no' : a.answer }));
        const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
          { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'yes' },
          startup,
          { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'n' },
          { prompt: 'and make the ballin command available? [y/N] ', answer: 'y' },
          { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
          { prompt: 'Enable tab completion in ', answer: 'n' },
          ...backupSetup,
          { prompt: 'Create this private GitHub backup without sensitive sources? [y/N] ', answer: acceptBackup ? '\x04' : 'no', raw: acceptBackup },
        ], shell, { columns: 200 });
        assert.isUndefined(result.error, result.stderr);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const output = result.stdout.replace(/\r\n/gu, '\n');
        const reminder = 'Ballin is installed. PATH setup wasn’t verified. Manual setup: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup';
        assert.include(output, reminder + '\n', output);
        assert.equal(output.split(reminder).length - 1, 1);
        assert.notInclude(output, '😎 Setup complete!');
        assert.notInclude(output, 'Run a backup now and open');
        const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
        assert.notProperty(config.backup, 'repository');
        assert.isTrue(JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8')).requests.every((r: {method: string}) => r.method === 'GET'));
        assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.backup-cache')));
      });
    }
  }

  it('skips GitHub sign-in and backup prompts while completing maintenance installation', () => {
    sandbox = createSandbox({ quickstart: true }); selectScenario(sandbox, 'auth');
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'no' },
      { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' },
      { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
      { prompt: 'and make the ballin command available? [y/N] ', answer: 'y' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
      { prompt: 'Enable tab completion in ', answer: 'n' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(result.stdout, 'GitHub CLI sign-in:');
    assert.include(result.stdout, 'Backup setup skipped.');
    assert.notInclude(result.stdout, 'Set up private backups to GitHub?');
    assert.notInclude(result.stdout, 'Run your first backup');
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.notProperty(config.backup, 'repository'); assert.equal(config.update.backup, 'false');
    assert.isTrue(fs.lstatSync(path.join(sandbox.bin, 'ballin')).isSymbolicLink());
    const remote = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
    assert.isEmpty(remote.requests);
    for (const name of ['install_setup.ts', 'backup_setup.ts', 'backup_preferences.ts', 'completion_setup.ts', 'analytics.ts']) {
      assert.deepEqual(fs.readFileSync(path.join(sandbox.repo, 'commands', name)), fs.readFileSync(path.join(sandbox.source, 'commands', name)));
    }
  });

  it('waits for an explicit name after a transferred-owner suggestion and still requires final consent', () => {
    sandbox = createSandbox();
    const installed = runSandbox(sandbox, ['install'], 'y\nn\nn\n');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const configPath = path.join(sandbox.repo, 'ballin.config.json'); const before = fs.readFileSync(configPath, 'utf8');
    const remotePath = path.join(sandbox.remote, 'repository.json'); const remote = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
    remote.faults.candidate = 'redirect'; remote.faults.candidateMetadata = { owner: { node_id: 'U_transferred', type: 'User' } };
    fs.writeFileSync(remotePath, JSON.stringify(remote));
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'backup', 'setup'], [
      { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'y' },
      { prompt: 'Reconnect to an existing backup or create a new one? [reconnect/create] ', answer: 'create' },
      { prompt: 'Repository name: ', answer: 'fresh-name' },
      { prompt: 'Review files that may contain credentials or private information for backup inclusion? [y/N] ', answer: 'n' },
      { prompt: 'private GitHub backup ', answer: 'n' },
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stdout, 'Proposed backup: https://github.com/fixture-user/fresh-name');
    assert.include(result.stdout, 'Backup setup cancelled.'); assert.notInclude(result.stdout, 'Available suggestion:');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    const after = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
    assert.equal(after.head, remote.head); assert.equal(after.exists, remote.exists);
    assert.isTrue(after.requests.every((request: { method: string }) => request.method === 'GET'));
    assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.backup-cache')));
  });

  it('waits at the automatic-backup prompt after direct setup initializes its destination', () => {
    sandbox = createSandbox();
    const installed = runSandbox(sandbox, ['install'], 'y\nn\nn\n');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'backup', 'setup'], backupAnswers);
    assert.isUndefined(result.error, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Creating private backup…');
    assert.include(result.stdout, 'Automatic backup during updates: enabled (`update.backup` set to `true`).');
    assert.include(result.stdout, 'Backup setup complete.');
    assertInitializedOnly();
  });
});
