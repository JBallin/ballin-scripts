const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, runSandbox, resetRemote, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { selectScenario } = require('./helpers/sandbox_scenarios.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('interactive setup with delayed terminal answers', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  afterEach(() => { if (sandbox && fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });

  const backupAnswers = [
    { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'y' },
    { prompt: 'GitHub hostname [github.com]: ', answer: '' },
    { prompt: 'Create a new backup or reconnect to an existing one? [CREATE/reconnect] ', answer: '' },
    { prompt: 'Repository name [ballin-backups]: ', answer: 'interactive-test' },
    { prompt: 'Review files that may contain credentials or private information for backup inclusion? [y/N] ', answer: 'y' },
    { prompt: 'private GitHub backup ', answer: 'y' },
    { prompt: 'Automatically run \x1b[1mballin backup\x1b[0m as part of \x1b[1mballin update\x1b[0m? [y/N] ', answer: 'y' },
  ];
  const assertBackupHeading = (stdout: string): void => {
    const output = stdout.replace(/\r\n/gu, '\n');
    const heading = '\x1b[34m==>\x1b[1;39m Setting up GitHub backup\x1b[0m';
    assert.equal(output.split(heading).length - 1, 1);
    assert.include(output, heading + '\nCreate a new backup or reconnect to an existing one? [CREATE/reconnect] ');
  };
  const assertInitializedOnly = (): void => {
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.deepEqual(config.backup.repository, { host: 'github.com', id: 'R_fixture', ownerId: 'U_fixture', name: 'interactive-test', branch: 'main' });
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
        : { prompt: `Zsh settings directory [Enter for home (~), an absolute directory, or skip]: `, answer: '' };
      const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
        { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'yes' },
        backupAnswers[1],
        startup,
        { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
        { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
        { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
        { prompt: 'Enable tab completion in ', answer: 'y' },
        ...backupAnswers.slice(2),
        { prompt: 'Run a backup now and open its GitHub destination? [Y/n] ', answer: 'n' },
      ], shell);
      assert.isUndefined(result.error, result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      assert.include(output, `$ git clone https://github.com/JBallin/ballin-scripts.git ~/.ballin-scripts\n\n⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n`);
      assert.include(output, 'Share usage analytics to help improve Ballin? [y/N] \n\nEnable tab completion in ');
      assert.notInclude(output, '\n\n\n');
      assert.include(result.stdout, '\x1b[34m==>\x1b[1;39m Setting up Ballin\x1b[0m');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.split(backupAnswers[1].prompt).length - 1, 1, 'Quickstart selects the host once');
      assert.isBelow(result.stdout.indexOf(backupAnswers[1].prompt), result.stdout.indexOf(startup.prompt));
      assert.equal(result.stdout.split(startup.prompt).length - 1, 1, 'Reuse the selected location without repeating its question');
      assert.notInclude(result.stdout, 'Tab completion enabled.');
      assert.notInclude(result.stdout, 'Usage analytics:');
      const terminalGuidance = '😎 Setup complete! Open a new Terminal and run \x1b[1mballin help\x1b[0m.';
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
      assertBackupHeading(result.stdout);
      assertInitializedOnly();
    });
  }

  it('uses one separator after tab completion when Quickstart backups are declined', () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'n' },
      { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' },
      { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
      { prompt: 'Enable tab completion in ', answer: 'y' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout.replace(/\r\n/gu, '\n');
    assert.include(output, `Enable tab completion in ~/.bash_profile? [y/N] y\n\n😎 Setup complete!`);
    assert.include(output, 'Proceed with installation? [y/N] y\n\x1b[34m==>\x1b[1;39m Installing Ballin\x1b[0m\n');
    assert.include(output, '⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n\nAnalytics details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md#what-will-analytics-share\nShare usage analytics to help improve Ballin? [y/N] n\n\nEnable tab completion in ');
    assert.notInclude(output, '\n\n\n');
    assert.include(output, `$ git clone https://github.com/JBallin/ballin-scripts.git ~/.ballin-scripts\n\n⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n`);
  });

  for (const scenario of ['quiet', 'migration', 'unconfigured', 'backup', 'migrated backup']) {
    for (const fetchOutput of [false, true]) {
      it(`separates real refresh output for ${scenario} (fetch output: ${fetchOutput})`, () => {
        sandbox = createSandbox();
        fs.mkdirSync(sandbox.repo);
        for (const name of ['commands', 'config', 'bin', 'completions', 'package.json']) {
          fs.cpSync(path.join(sandbox.source, name), path.join(sandbox.repo, name), { recursive: true });
        }
        const backup = scenario.includes('backup');
        const migration = scenario === 'migration' || scenario === 'migrated backup';
        if (scenario !== 'unconfigured') {
          const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'config/.defaultConfig.json'), 'utf8'));
          delete config.backup.repository;
          delete config.backup.includeSensitive;
          if (backup) {
            resetRemote(sandbox, true);
            config.backup.repository = { host: 'github.com', id: 'R_fixture', ownerId: 'U_fixture', name: 'ballin-backups', branch: 'main' };
            config.backup.includeSensitive = 'false';
          }
          if (migration) delete config.update;
          fs.writeFileSync(path.join(sandbox.repo, 'ballin.config.json'), JSON.stringify(config));
        }
        const progress = 'remote: Enumerating objects: 3, done.\n';
        if (fetchOutput) {
          const git = path.join(sandbox.tools, 'git');
          const stub = fs.readFileSync(git, 'utf8').replace("if (args[0] === 'fetch' &&",
            `if (args[0] === 'fetch') process.stderr.write(${JSON.stringify(progress)});\n  if (args[0] === 'fetch' &&`);
          fs.writeFileSync(git, stub);
          sandbox.expected.set(git, stub);
        }
        const answers = scenario === 'unconfigured' ? [
          { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
          { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' },
          { prompt: 'Enable tab completion in ', answer: 'n' },
          { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'n' },
        ] : [];
        const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'install.sh')], answers, 'bash', { term: 'dumb', columns: 240 });
        assert.isUndefined(result.error, result.stderr);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const output = result.stdout.replace(/\r\n/gu, '\n');
        const update = '==> Updating Ballin\n' + (fetchOutput ? progress : '');
        const docs = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';
        const summary = 'Validated private backup: https://github.com/fixture-user/ballin-backups\nSensitive sources: excluded\nAutomatic backup during update: disabled\n';
        if (migration) {
          assert.include(output, update + '\n🙌 New configuration options have been added! Here are the updates:\n');
          if (backup) assert.include(output, `${docs}#what-installation-changes\n\n${summary}`);
          else assert.include(output, `${docs}#what-installation-changes\n\n😎 Setup complete!`);
        } else if (backup) assert.include(output, update + '\n' + summary);
        else if (scenario === 'quiet') assert.include(output, update + '\n😎 Setup complete!');
        else assert.include(output, update + `\nInitial configuration\n${docs}#what-will-installation-change\n⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n`);
        assert.notInclude(output, '\n\n\n');
      });
    }
  }

  for (const columns of [60, 240]) {
    it(`installs into absolute HOME from a non-home directory at ${columns} columns`, () => {
      sandbox = createSandbox({ quickstart: true });
      const launchDirectory = path.join(sandbox.root, 'launch');
      fs.mkdirSync(launchDirectory);
      const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
        { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'n' },
        { prompt: 'Zsh settings directory [Enter for home (~), an absolute directory, or skip]: ', answer: '' },
        { prompt: 'Add Ballin setup to ~/.zshrc so it works in new Terminal windows? [y/N] ', answer: 'y' },
        { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
        { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
        { prompt: 'Enable tab completion in ~/.zshrc? [y/N] ', answer: 'y' },
      ], 'zsh', { columns, term: 'dumb', cwd: launchDirectory });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      assert.include(output, '  - Create Ballin and its settings in ~/.ballin-scripts\n  - Link the Ballin command in ~/.local/bin\n');
      assert.include(output, '$ git clone https://github.com/JBallin/ballin-scripts.git ~/.ballin-scripts\n\n⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n');
      assert.include(fs.readFileSync(sandbox.log, 'utf8'), `git:clone https://github.com/JBallin/ballin-scripts.git ${sandbox.repo}\n`);
      assert.isTrue(fs.existsSync(path.join(sandbox.repo, 'ballin.config.json')));
      assert.equal(fs.readlinkSync(path.join(sandbox.home, '.local/bin/ballin')), path.join(sandbox.repo, 'bin/ballin'));
      const profile = fs.readFileSync(path.join(sandbox.home, '.zshrc'), 'utf8');
      assert.include(profile, path.join(sandbox.home, '.local/bin'));
      assert.include(profile, 'completions/_ballin');
      assert.isEmpty(fs.readdirSync(launchDirectory));
      assert.notInclude(output, sandbox.home);
      assert.notInclude(output, '\n\n\n');
    });
  }

  it('keeps clone and onboarding spacing in a plain terminal', () => {
    sandbox = createSandbox();
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'install.sh')], [
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
      { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' },
      { prompt: 'Enable tab completion in ', answer: 'n' },
      { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'n' },
    ], 'bash', { term: 'dumb' });
    assert.isUndefined(result.error, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout.replace(/\r\n/gu, '\n');
    assert.include(output, `$ git clone https://github.com/JBallin/ballin-scripts.git ~/.ballin-scripts\n\n⚙️  Created config: ~/.ballin-scripts/ballin.config.json\n`);
    assert.include(output, 'Share usage analytics to help improve Ballin? [y/N] \n\nWhich Bash startup file does your terminal read? ');
    assert.notInclude(output, '\x1b[');
    assert.notInclude(output, '\n\n\n');
  });

  for (const shell of ['bash', 'zsh'] as const) {
    for (const acceptBackup of [false, true]) {
      it(`ends with the PATH reminder after backup ${acceptBackup ? 'acceptance' : 'decline'} (${shell})`, () => {
        sandbox = createSandbox({ quickstart: true });
        const startup = shell === 'bash'
          ? { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' }
          : { prompt: `Zsh settings directory [Enter for home (~), an absolute directory, or skip]: `, answer: '' };
        const backupSetup = backupAnswers.slice(2, 5).map(a => ({ ...a, answer: a.prompt.startsWith('Review ') ? 'no' : a.answer }));
        const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'quickstart.sh')], [
          { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'yes' },
          backupAnswers[1],
          startup,
          { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'n' },
          { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
          { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
          { prompt: 'Enable tab completion in ', answer: 'n' },
          ...backupSetup,
          { prompt: 'Create this private GitHub backup without sensitive sources? [y/N] ', answer: acceptBackup ? '\x04' : 'no', raw: acceptBackup },
        ], shell, { columns: 200 });
        assert.isUndefined(result.error, result.stderr);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.stdout.split(backupAnswers[1].prompt).length - 1, 1, 'Quickstart selects the host once');
        assert.isBelow(result.stdout.indexOf(backupAnswers[1].prompt), result.stdout.indexOf(startup.prompt));
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
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
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
      { prompt: 'GitHub hostname [github.com]: ', answer: '' },
      { prompt: 'Create a new backup or reconnect to an existing one? [CREATE/reconnect] ', answer: '' },
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
    assertBackupHeading(result.stdout);
    assert.include(result.stdout, 'Creating private backup…');
    assert.include(result.stdout, 'Automatic backup during updates: enabled (`update.backup` set to `true`).');
    assert.include(result.stdout, 'Backup setup complete.');
    assertInitializedOnly();
  });
});
