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
    { prompt: 'Set up optional private backups now? [y/N] ', answer: 'y' },
    { prompt: 'Reconnect to an existing backup or create a new one? [reconnect/create] ', answer: 'create' },
    { prompt: 'Repository name [ballin-backups]: ', answer: 'interactive-test' },
    { prompt: 'Review sensitive sources for inclusion? [y/N] ', answer: 'y' },
    { prompt: 'Confirm this destination and source selection? [y/N] ', answer: 'y' },
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
        : { prompt: `Directory containing your .zshrc [Enter=${sandbox.home}; absolute directory or skip]: `, answer: '' };
      const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
        startup,
        { prompt: 'Add this PATH line? [y/N] ', answer: 'y' },
        { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
        { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
        startup,
        { prompt: 'Enable shell completion? [y/N] ', answer: 'y' },
        ...backupAnswers,
        { prompt: 'Run your first backup and open its GitHub destination? [Y/n] ', answer: 'n' },
      ], shell);
      assert.isUndefined(result.error, result.stderr);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Shell completion enabled.');
      assert.include(result.stdout, 'Analytics: No.');
      assert.include(result.stdout, 'Continue setup here; open a new Terminal afterward.');
      assert.include(result.stdout, 'Backup setup complete.');
      assert.notInclude(result.stdout, 'Unable to prepare backup configuration.');
      assert.notInclude(result.stdout, 'Shell completion setup could not finish.');
      assert.include(fs.readFileSync(path.join(sandbox.home, shell === 'bash' ? '.bash_profile' : '.zshrc'), 'utf8'),
        shell === 'bash' ? 'completions/ballin.bash' : 'completions/_ballin');
      assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8')).analytics.enabled, 'false');
      assertInitializedOnly();
    });
  }

  it('skips GitHub sign-in and backup prompts while completing maintenance installation', () => {
    sandbox = createSandbox({ quickstart: true }); selectScenario(sandbox, 'auth');
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
      { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' },
      { prompt: 'Add this PATH line? [y/N] ', answer: 'y' },
      { prompt: 'Sign in now? [Y/n] ', answer: 'n' },
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
      { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: '' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'GitHub CLI sign-in: Skipped.');
    assert.include(result.stdout, 'Backup setup deferred.');
    assert.notInclude(result.stdout, 'Set up optional private backups now?');
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

  it('waits at the automatic-backup prompt after direct setup initializes its destination', () => {
    sandbox = createSandbox();
    const installed = runSandbox(sandbox, ['install'], 'y\nn\nn\n');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'backup', 'setup'], backupAnswers);
    assert.isUndefined(result.error, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Creating and initializing private backup...');
    assert.include(result.stdout, 'Automatic backup: Yes.');
    assert.include(result.stdout, 'Backup setup complete.');
    assertInitializedOnly();
  });
});
