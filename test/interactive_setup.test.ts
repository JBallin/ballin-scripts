const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { selectScenario } = require('./helpers/sandbox_scenarios.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
const { stripAnsi } = require('../commands/terminalStyle.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('integrated setup with delayed terminal answers', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  const plain = (text: string): string => stripAnsi(text).replace(/\r\n/gu, '\n');
  const config = () => JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
  const remote = () => JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
  const publicCommand = (guide: string): string[] => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', guide), 'utf8');
    const command = text.match(/```shell\n([\s\S]*?)\n```/)?.[1]; assert.isString(command);
    return ['/bin/bash', '-c', (guide === 'README.md' ? 'export PATH="$PATH:$HOME/.local/bin"; ' : '') + command];
  };
  const startup = (shell: 'bash' | 'zsh') => shell === 'bash'
    ? { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: 'login' }
    : { prompt: 'Zsh settings directory [Enter for home (~), an absolute directory, or skip]: ', answer: '' };
  const updates = [
    { prompt: 'Update global npm packages? [y/N] ', answer: '' },
    { prompt: 'Update Ballin? [Y/n] ', answer: '' },
    { prompt: 'Clean up Homebrew? [Y/n] ', answer: '' },
    { prompt: 'Update macOS? [Y/n] ', answer: '' },
  ];
  const backup = [
    { prompt: 'Create a new backup or reconnect to an existing one? [CREATE/reconnect] ', answer: '' },
    { prompt: 'Repository name [ballin-backups]: ', answer: 'interactive-test' },
    { prompt: 'Include sensitive sources in future backups? [y/N] ', answer: 'y' },
    { prompt: 'Create this private GitHub backup including sensitive sources? [y/N] ', answer: 'y' },
  ];
  afterEach(() => { if (sandbox && fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });

  for (const answer of ['n', '\x04']) it(`preserves direct required-consent cancellation ${JSON.stringify(answer)}`, () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, publicCommand('README.md'), [
      { prompt: 'Proceed with installation? [y/N] ', answer, raw: answer === '\x04' },
    ]);
    assert.equal(result.status, answer === '\x04' ? 1 : 0, result.stdout + result.stderr);
    assert.isFalse(fs.existsSync(sandbox.repo)); assert.notInclude(result.stdout, 'Setup complete.');
    assert.notInclude(fs.existsSync(sandbox.log) ? fs.readFileSync(sandbox.log, 'utf8') : '', 'git:clone');
  });
  it('ends Quickstart before prerequisite work when the early backup question reaches EOF', () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, publicCommand('docs/quickstart.md'), [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: '\x04', raw: true },
    ]);
    assert.equal(result.status, 0, result.stderr); assert.isFalse(fs.existsSync(sandbox.repo));
    assert.notInclude(result.stdout, 'Checking required tools');
  });

  for (const shell of ['bash', 'zsh'] as const) it(`coordinates one backup/general review through Quickstart in ${shell}`, () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, publicCommand('docs/quickstart.md'), [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'yes' },
      { prompt: 'Use NVM with Node.js LTS instead? [y/N] ', answer: 'no' },
      { prompt: 'GitHub hostname [github.com]: ', answer: '' },
      startup(shell),
      { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      { prompt: 'Enable Ballin tab completion? ', answer: 'y' },
      ...backup,
      { prompt: 'Review your Ballin preferences? [Y/n] ', answer: 'y' },
      ...updates,
      { prompt: 'Back up to GitHub during updates? [y/N] ', answer: 'y' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
      { prompt: 'Run a backup now and open its GitHub destination? [Y/n] ', answer: 'n' },
    ], shell);
    const output = plain(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(output.split('==> Setting up GitHub backup').length - 1, 1);
    assert.equal(output.split('GitHub hostname [github.com]:').length - 1, 1);
    assert.notInclude(output, 'Set up private backups to GitHub?');
    assert.equal(output.split('Setup complete.').length - 1, 1);
    assert.isBelow(output.indexOf('Ballin installed successfully.'), output.indexOf('==> Setting up GitHub backup'));
    assert.isBelow(output.indexOf('Private backup created:'), output.indexOf('==> ballin update'));
    assert.isBelow(output.indexOf('==> Analytics'), output.indexOf('Run a backup now'));
    assert.notInclude(output, '\n\n\n');
    assert.equal(config().backup.includeSensitive, 'true'); assert.equal(config().update.backup, 'true'); assert.equal(config().analytics.enabled, 'false');
    assert.deepEqual(Object.keys(remote().commits[remote().head].files).sort(), ['.ballin-backup.json', 'README.md']);
    assert.notInclude(result.stdout, '\x1b[34m[y/N]'); // Brackets and uppercase defaults stay neutral.
    assert.include(result.stdout, '[y/N]');
    assert.notInclude(result.stdout, '[y/\x1b[1mN\x1b[0m]');
    assert.include(result.stdout, '\x1b[0;32m✓\x1b[0m Setup complete.');
  });

  it('switches to controlled NVM/LTS, persists No, and keeps backup decline independent of general review', () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, [sandbox.quickstartEntry], [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'n' },
      { prompt: 'Use NVM with Node.js LTS instead? [y/N] ', answer: 'y' },
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      startup('bash'),
      { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'y' },
      { prompt: 'Enable Ballin tab completion? ', answer: 'n' },
      { prompt: 'Review your Ballin preferences? [Y/n] ', answer: 'y' },
      ...updates,
      { prompt: 'Update Node.js LTS through NVM? [Y/n] ', answer: 'n' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(config().update.nvm, 'false'); assert.notProperty(config(), '_setup'); assert.isEmpty(remote().requests);
    assert.notInclude(fs.readFileSync(sandbox.log, 'utf8'), 'gh-auth:');
    const rerun = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'setup'], [
      ...updates, { prompt: 'Update Node.js LTS through NVM? [y/N] ', answer: '' },
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: '' },
    ]);
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr); assert.equal(config().update.nvm, 'false');
  });

  it('offers general preferences after a normal direct-installer backup decline', () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, publicCommand('README.md'), [
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' }, startup('bash'),
      { prompt: 'Enable Ballin tab completion? ', answer: 'n' },
      { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'n' },
      { prompt: 'Review your Ballin preferences? [Y/n] ', answer: 'y' }, ...updates,
      { prompt: 'Share usage analytics to help improve Ballin? [y/N] ', answer: 'n' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.isEmpty(remote().requests);
    assert.equal(plain(result.stdout).split('Setup complete.').length - 1, 1);
  });

  it('ends auth failure with one specific recovery block, then allows standalone recovery', () => {
    sandbox = createSandbox({ quickstart: true }); selectScenario(sandbox, 'auth');
    const failed = runInteractiveSetup(sandbox, publicCommand('README.md'), [
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' }, startup('bash'),
      { prompt: 'Enable Ballin tab completion? ', answer: 'n' },
      { prompt: 'Set up private backups to GitHub? [y/N] ', answer: 'y' },
      { prompt: 'GitHub hostname [github.com]: ', answer: '' },
    ], 'bash');
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const output = plain(failed.stdout);
    assert.include(output, '\n\n✗ GitHub CLI authentication is required.\nRun gh auth login --hostname github.com, then run ballin backup setup.\n');
    assert.equal(output.split('authentication is required.').length - 1, 1);
    assert.notInclude(output, 'Review your update'); assert.notInclude(output, 'Setup complete.'); assert.notInclude(output, 'setup incomplete');
    assert.include(failed.stdout, '\x1b[0;31m✗\x1b[0m GitHub CLI');
    selectScenario(sandbox, 'none');
    const recovered = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'backup', 'setup'], [
      { prompt: 'GitHub hostname [github.com]: ', answer: '' }, ...backup,
    ]);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.equal(plain(recovered.stdout).split('Run ballin setup to review your other preferences.').length - 1, 1);
    assert.notInclude(recovered.stdout, 'Back up to GitHub during updates?'); assert.equal(config().update.backup, 'false');
  });

  it('waits through an invalid answer and preserves confirmed versus partial choices on terminal EOF', () => {
    sandbox = createSandbox(); assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    const result = runInteractiveSetup(sandbox, [path.join(sandbox.bin, 'ballin'), 'setup'], [
      { prompt: 'Update global npm packages? [y/N] ', answer: 'invalid' },
      { prompt: 'Update global npm packages? [y/N] ', answer: 'yes' },
      { prompt: 'Update Ballin? [Y/n] ', answer: 'no\x04\x04', raw: true },
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.include(result.stdout, 'Enter Yes or No.');
    assert.equal(config().update.npm, 'true'); assert.equal(config().update.selfUpdate, 'true');
    assert.notInclude(result.stdout, 'Setup complete.'); assert.include(result.stdout, 'Review cancelled.');
    assert.equal(plain(result.stdout).split('Run ballin backup setup').length - 1, 1);
  });

  for (const mode of ['styled', 'NO_COLOR', 'dumb']) {
    it(`preserves native Bash Enter-to-skip consent and rendering in ${mode}`, () => {
      sandbox = createSandbox({ quickstart: true });
      const files = ['.bash_profile', '.bash_login', '.bashrc', '.profile'].map(name => path.join(sandbox.home, name));
      const before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : undefined);
      const command = mode === 'NO_COLOR' ? ['/usr/bin/env', 'NO_COLOR=1', sandbox.quickstartEntry] : [sandbox.quickstartEntry];
      const result = runInteractiveSetup(sandbox, command, [
        { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'n' },
        { prompt: 'Use NVM with Node.js LTS instead? [y/N] ', answer: 'n' },
        { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: '' },
        { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
        { prompt: 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] ', answer: '' },
        { prompt: 'Review your Ballin preferences? [Y/n] ', answer: 'n' },
      ], 'bash', { term: mode === 'dumb' ? 'dumb' : 'xterm' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = plain(result.stdout);
      assert.include(output, 'PATH setup skipped.');
      assert.include(output, 'Tab completion skipped.');
      assert.include(output, 'Ballin is installed. PATH setup wasn’t verified.');
      assert.notInclude(output, 'Setup complete.');
      const cyanSkip = '\x1b[36mSkip\x1b[0m';
      if (mode === 'styled') {
        assert.equal(result.stdout.split(cyanSkip).length - 1, 2);
        assert.include(result.stdout, '[login/bashrc; Enter to skip] ' + cyanSkip);
        assert.include(result.stdout, '\x1b[1A\r\x1b[J');
      } else {
        assert.notInclude(result.stdout, '\x1b[');
        assert.notInclude(result.stdout, cyanSkip);
      }
      files.forEach((file, index) => {
        if (before[index] === undefined) assert.isFalse(fs.existsSync(file));
        else assert.deepEqual(fs.readFileSync(file), before[index]);
      });
      assert.isEmpty(remote().requests);
    });
  }

  it('keeps the PATH-unverified ending after shell activation is declined', () => {
    sandbox = createSandbox({ quickstart: true });
    const result = runInteractiveSetup(sandbox, [sandbox.quickstartEntry], [
      { prompt: 'Set up backups to GitHub? [Y/n] ', answer: 'n' },
      { prompt: 'Use NVM with Node.js LTS instead? [y/N] ', answer: 'n' }, startup('bash'),
      { prompt: 'so it works in new Terminal windows? [y/N] ', answer: 'n' },
      { prompt: 'Proceed with installation? [y/N] ', answer: 'y' },
      { prompt: 'Enable Ballin tab completion? ', answer: 'n' },
      { prompt: 'Review your Ballin preferences? [Y/n] ', answer: 'n' },
    ], 'bash');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(plain(result.stdout), 'Ballin is installed. PATH setup wasn’t verified.');
    assert.notInclude(result.stdout, 'Setup complete.'); assert.isEmpty(remote().requests);
  });
});
