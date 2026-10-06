const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox, resetRemote, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('first-run onboarding walkthroughs', function() {
  this.timeout(sandboxSuiteTimeout);
  let testDir: string;
  let homeDir: string;
  let userBinDir: string;
  let installedRepoDir: string;
  let commandLogPath: string;
  let remoteRepositoryDir: string;
  let sandbox: Sandbox;

  const { fixtureDestination } = require('./helpers/repository.ts');
  const { managedBranchRulesetName, repositoryCacheDirectory } = require('../commands/backup_repository.ts');
  const remoteState = () => JSON.parse(fs.readFileSync(path.join(remoteRepositoryDir, 'repository.json'), 'utf8'));
  const remoteFile = (name: string) => Buffer.from(remoteState().commits[remoteState().head].files[name], 'base64').toString();

  const runInstaller = (input: string) => runSandbox(sandbox, ['install'], input);
  const runInstalled = (args: string[]) => runSandbox(sandbox, args);

  const commandLog = (): string => (
    fs.existsSync(commandLogPath) ? fs.readFileSync(commandLogPath, 'utf8') : ''
  );

  beforeEach(() => {
    sandbox = createSandbox();
    testDir = sandbox.root;
    homeDir = sandbox.home;
    userBinDir = sandbox.bin;
    installedRepoDir = sandbox.repo;
    commandLogPath = sandbox.log;
    remoteRepositoryDir = sandbox.remote;
  });

  afterEach(() => {
    if (testDir) cleanupSandbox(testDir);
  });

  it('preserves one maintenance-only install through doctor, update, self-update, and backup guidance', () => {
    const installResult = runInstaller('y\nn\nn\n');

    assert.equal(installResult.status, 0, installResult.stderr);
    assert.include(installResult.stdout, 'Installation plan');
    assert.lengthOf(installResult.stdout.match(/installation\.md#what-will-installation-change/gu) ?? [], 1);
    assert.include(installResult.stdout, 'Share usage analytics to help improve Ballin? [y/N]');
    assert.include(installResult.stdout, 'Backup setup skipped. Run `ballin backup setup`');
    assert.isTrue(fs.lstatSync(path.join(userBinDir, 'ballin')).isSymbolicLink());
    assert.notProperty(JSON.parse(fs.readFileSync(path.join(installedRepoDir, 'ballin.config.json'), 'utf8')).backup, 'repository');

    const doctorResult = runInstalled(['doctor']);
    const verboseDoctorResult = runInstalled(['doctor', '--verbose']);
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.equal(doctorResult.stdout, '😎 You\'re ballin.\n');
    assert.equal(verboseDoctorResult.status, 0, verboseDoctorResult.stderr);
    assert.include(verboseDoctorResult.stdout, 'INFO  Optional backup');
    assert.include(verboseDoctorResult.stdout, 'ballin backup setup');

    [
      ['update.cleanup', 'false'],
      ['update.selfUpdate', 'false'],
      ['update.softwareupdate', 'false'],
    ].forEach(([key, value]) => {
      const configResult = runInstalled(['config', 'set', key, value]);
      assert.equal(configResult.status, 0, configResult.stderr);
    });

    const updateResult = runInstalled(['update']);
    const selfUpdateResult = runInstalled(['self-update']);
    const backupResult = runInstalled(['backup']);
    assert.equal(updateResult.status, 0, updateResult.stderr);
    assert.equal(selfUpdateResult.status, 0, selfUpdateResult.stderr);
    assert.equal(selfUpdateResult.stdout, 'Updating Ballin...\nBallin updated.\n'
      + 'Backup source definitions may have changed. Sensitive-source opt-in covers current and future supported sources.\n'
      + 'Review: https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md\n');
    assert.equal(backupResult.status, 1);
    assert.include(backupResult.stderr, "run `ballin backup setup` to enable it");
    assert.notInclude(commandLog(), 'gh:');
    assert.include(commandLog(), 'git:fetch --quiet origin +main:refs/remotes/origin/main');
  });

  it('preserves one created destination through first backup, open, read, and uninstall', () => {
    resetRemote(sandbox);
    const installResult = runInstaller('y\nn\ny\ncreate\n\ny\ny\ny\n');

    assert.equal(installResult.status, 0, installResult.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(installedRepoDir, 'ballin.config.json'), 'utf8'));
    assert.notProperty(config.backup, 'host');
    assert.deepEqual(config.backup.repository, fixtureDestination);
    assert.equal(config.update.backup, 'true');
    assert.deepEqual(Object.keys(remoteState().commits[remoteState().head].files).sort(), ['.ballin-backup.json', 'README.md']);

    const zshrc = 'export BALLIN_WALKTHROUGH=1\n';
    fs.writeFileSync(path.join(homeDir, '.zshrc'), zshrc);
    const backupResult = runInstalled(['backup']);
    assert.equal(backupResult.status, 0, backupResult.stderr);
    assert.include(backupResult.stdout, '✚ zshrc');
    assert.equal(remoteFile('zshrc.sh'), zshrc);
    assert.equal(
      fs.readFileSync(path.join(repositoryCacheDirectory(path.join(installedRepoDir, '.backup-cache'), fixtureDestination), 'zshrc.sh'), 'utf8'),
      zshrc,
    );

    const openResult = runInstalled(['backup', 'open']);
    const readResult = runInstalled(['backup', 'read', 'zshrc.sh']);
    assert.equal(openResult.status, 0, openResult.stderr);
    assert.equal(readResult.status, 0, readResult.stderr);
    assert.equal(readResult.stdout, zshrc);

    const uninstallResult = runInstalled(['uninstall']);
    assert.equal(uninstallResult.status, 0, uninstallResult.stderr);
    assert.isFalse(fs.existsSync(installedRepoDir));
    assert.isFalse(fs.existsSync(path.join(userBinDir, 'ballin')));
    assert.equal(remoteFile('zshrc.sh'), zshrc);

    const requests = remoteState().requests;
    assert.equal(requests.filter((r: { endpoint: string }) => r.endpoint === 'user/repos').length, 1);
    assert.equal(requests.filter((r: { endpoint: string }) => r.endpoint === 'open').length, 1);
    const rulesetWrites = requests.filter((r: { endpoint: string; method: string }) => r.endpoint.endsWith('/rulesets') && r.method === 'POST');
    assert.lengthOf(rulesetWrites, 1);
    assert.deepEqual(rulesetWrites[0].payload, {
      name: managedBranchRulesetName, target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    });
    const publications = requests
      .map((request: { payload?: { query?: string } }, index: number) => request.payload?.query?.includes('BallinPublish') ? index : -1)
      .filter((index: number) => index >= 0);
    const protection = requests.findIndex((request: { endpoint: string; method: string }) => (
      request.endpoint.endsWith('/rulesets') && request.method === 'POST'
    ));
    assert.lengthOf(publications, 2); assert.isBelow(publications[0], protection); assert.isBelow(protection, publications[1]);
    assert.isTrue(requests.every((r: { endpoint: string }) => !r.endpoint.includes('gists')));
  });
});
