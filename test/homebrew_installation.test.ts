const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createAnalyticsCapture, fixtureInstallId } = require('./helpers/analytics.ts');
const { isHomebrewInstallation, stateDirectory, readPackageMetadata, selectedPackageCommand, homebrewCommandOwner } = require('../commands/installation.ts');

describe('Homebrew package boundary experiment', () => {
  let root: string;
  let home: string;
  let first: string;
  const source = path.join(__dirname, '..');
  const packageAt = (name: string): string => {
    const destination = path.join(root, name);
    fs.mkdirSync(destination);
    for (const entry of ['commands', 'config', 'bin', 'package.json']) {
      fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
    }
    fs.writeFileSync(path.join(destination, '.ballin-package.json'), JSON.stringify({ manager: 'homebrew', schema: 1 }));
    return destination;
  };
  const run = (repo: string, ...args: string[]) => spawnSync(process.execPath, [path.join(repo, 'bin/ballin'), ...args], {
    env: { HOME: home, PATH: '/usr/bin:/bin', NO_COLOR: '1', TERM: 'dumb', BALLIN_NO_COMMAND_ANALYTICS: '1' },
    encoding: 'utf8', input: '', timeout: 15000,
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-brew-boundary-'));
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    first = packageAt('keg-one');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('backs up only the invoking installation preferences across package replacement', () => {
    const legacy = path.join(home, '.ballin-scripts');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'ballin.config.json'), JSON.stringify({ update: { cleanup: 'true' } }));
    const state = path.join(home, '.ballin');
    fs.mkdirSync(state);
    const preferences = path.join(state, 'ballin.config.json');
    fs.writeFileSync(preferences, JSON.stringify({ update: { cleanup: 'false' }, custom: { token: 'PRIVATE_FIXTURE' } }));
    const inspect = (repo: string) => spawnSync(process.execPath, ['-e', `
      const { configPath } = require(process.argv[1] + '/config/index.ts');
      const { observeSnapshotSources } = require(process.argv[1] + '/commands/backup_snapshots.ts');
      const source = observeSnapshotSources({ homeDir: process.env.HOME, env: process.env, configPath }, false)
        .find(item => item.definition.name === 'ballin_config');
      if (source.status !== 'available') { console.log(source.status); process.exit(0); }
      const result = require('child_process').spawnSync(source.collector.command, source.collector.args, {
        cwd: source.collector.cwd, env: source.collector.env, encoding: 'utf8'
      });
      process.stdout.write(result.stdout); process.exitCode = result.status;
    `, repo], { env: { HOME: home, PATH: '', BALLIN_NO_COMMAND_ANALYTICS: '1' }, encoding: 'utf8' });
    for (const repo of [first, packageAt('keg-two')]) {
      const result = inspect(repo);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { update: { cleanup: 'false' } });
      assert.notInclude(result.stdout, 'PRIVATE_FIXTURE');
    }
    const direct = packageAt('direct-checkout');
    fs.unlinkSync(path.join(direct, '.ballin-package.json'));
    fs.writeFileSync(path.join(direct, 'ballin.config.json'), JSON.stringify({ update: { cleanup: 'true' } }));
    assert.deepEqual(JSON.parse(inspect(direct).stdout), { update: { cleanup: 'true' } });
    fs.unlinkSync(preferences);
    assert.equal(inspect(first).stdout.trim(), 'absent', 'must not fall back to another installation');
    fs.mkdirSync(preferences);
    assert.equal(inspect(first).stdout.trim(), 'unavailable');
  });
  it('keeps Git layout only when no package marker exists', () => {
    assert.isFalse(isHomebrewInstallation(source));
    assert.equal(stateDirectory(source), source);
    fs.writeFileSync(path.join(first, '.ballin-package.json'), 'invalid');
    assert.throws(() => isHomebrewInstallation(first), 'Invalid Ballin package ownership');
  });
  it('fails closed for broken ownership metadata before touching a Git checkout', () => {
    const git = path.join(home, '.ballin-scripts');
    fs.mkdirSync(git);
    fs.writeFileSync(path.join(git, 'keep'), 'untouched');
    for (const contents of ['invalid', '{}', 'null']) {
      fs.writeFileSync(path.join(first, '.ballin-package.json'), contents);
      const result = run(first, 'uninstall');
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(git, 'keep'), 'utf8'), 'untouched');
    }
    fs.unlinkSync(path.join(first, '.ballin-package.json'));
    fs.symlinkSync(path.join(root, 'missing'), path.join(first, '.ballin-package.json'));
    assert.throws(() => isHomebrewInstallation(first), 'Unable to verify');
  });
  const receipt = (repo: string) => ({ manager: 'homebrew', schema: 2, formula: 'ballin-experiment',
    version: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version,
    sourceRevision: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), selection: { kind: 'development' },
    commandPath: path.join(repo, 'bin/ballin'), completionRoot: path.join(repo, 'completions'),
  });
  it('validates package provenance and distinguishes PATH shadowing without running commands', () => {
    fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify(receipt(first)));
    assert.equal(readPackageMetadata(first).selection.kind, 'development');
    assert.equal(selectedPackageCommand(first, { PATH: path.join(first, 'bin') }).status, 'pass');
    const other = path.join(root, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'ballin'), 'must not execute', { mode: 0o755 });
    assert.equal(selectedPackageCommand(first, { PATH: `${other}:${path.join(first, 'bin')}` }).status, 'warn');
    assert.equal(selectedPackageCommand(first, { PATH: '' }).status, 'fail');
    assert.include(run(first, 'self-update').stdout, 'brew upgrade ballin-experiment');
    assert.include(run(first, 'uninstall').stdout, 'brew uninstall ballin-experiment');
    const cwd = process.cwd();
    try {
      process.chdir(root);
      assert.equal(selectedPackageCommand(first, { PATH: `other:${path.join(first, 'bin')}` }).status, 'warn');
      fs.writeFileSync(path.join(root, 'ballin'), 'must not execute', { mode: 0o755 });
      assert.equal(selectedPackageCommand(first, { PATH: `:${path.join(first, 'bin')}` }).status, 'warn');
    } finally { process.chdir(cwd); }

    assert.isTrue(homebrewCommandOwner(path.join(first, 'bin/ballin')));
    fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify({ ...receipt(first), version: '99.0.0' }));
    assert.throws(() => readPackageMetadata(first), 'disagrees');
    fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify({ ...receipt(first), selection: { kind: 'release' } }));
    assert.throws(() => readPackageMetadata(first), 'Invalid Ballin package provenance');
    for (const formula of [undefined, null, 42]) {
      fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify({ ...receipt(first), formula }));
      assert.throws(() => readPackageMetadata(first), 'Invalid Ballin package provenance');
    }

  });
  it('refuses Git relinking over package commands and refuses package use of Git link setup', () => {
    const git = path.join(root, 'git'); fs.mkdirSync(path.join(git, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(git, 'bin/ballin'), 'git command');
    const target = path.join(root, 'target'); fs.mkdirSync(target);
    fs.symlinkSync(path.join(first, 'bin/ballin'), path.join(target, 'ballin'));
    const { symlinkBinaries } = require('../commands/install_setup.ts');
    assert.isFalse(symlinkBinaries(git, target));
    assert.equal(fs.realpathSync(path.join(target, 'ballin')), fs.realpathSync(path.join(first, 'bin/ballin')));
    assert.isFalse(symlinkBinaries(first, path.join(root, 'new-bin')));
    assert.isFalse(fs.existsSync(path.join(root, 'new-bin')));
  });
  it('preserves dangling package links for explicit repair', () => {
    const link = path.join(root, 'ballin');
    fs.symlinkSync(path.join(root, 'Cellar/ballin/old/bin/ballin'), link);
    assert.throws(() => homebrewCommandOwner(link), 'unresolved');
    assert.isTrue(fs.lstatSync(link).isSymbolicLink());
  });
  it('retains config across a new keg and leaves both code directories unwritten', () => {
    const reset = run(first, 'config', 'reset');
    assert.equal(reset.status, 0, reset.stderr);
    const set = run(first, 'config', 'set', 'update.npm', 'false');
    assert.equal(set.status, 0, set.stderr);
    const second = packageAt('keg-two');
    const get = run(second, 'config', 'get', 'update.npm');
    assert.equal(get.status, 0, get.stderr);
    assert.include(get.stdout, 'false');
    assert.isTrue(fs.existsSync(path.join(home, '.ballin/ballin.config.json')));
    for (const repo of [first, second]) assert.isFalse(fs.existsSync(path.join(repo, 'ballin.config.json')));
  });
  it('does not self-update or uninstall a coexisting Git checkout', () => {
    const git = path.join(home, '.ballin-scripts');
    fs.mkdirSync(git);
    fs.writeFileSync(path.join(git, 'keep'), 'untouched');
    for (const command of ['self-update', 'uninstall']) {
      const result = run(first, command);
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Homebrew manages');
      assert.equal(fs.readFileSync(path.join(git, 'keep'), 'utf8'), 'untouched');
      assert.isTrue(fs.existsSync(path.join(first, 'bin/ballin')));
    }
  });
  for (const [cleanup, upgradeStatus, backupStatus, cleanupStatus] of [[true, 0, 0, 0], [false, 0, 0, 0], [true, 7, 0, 0], [true, 0, 8, 0], [true, 0, 0, 9], [true, 130, 0, 0], [true, 0, 143, 0]] as const) {
    it(`keeps the running keg through backup and cleanup (cleanup=${cleanup}, statuses=${upgradeStatus}/${backupStatus}/${cleanupStatus})`, () => {
      const tools = path.join(root, 'tools');
      fs.mkdirSync(tools);
      const log = path.join(root, 'order');
      const backup = path.join(tools, 'backup');
      fs.writeFileSync(backup, `#!/bin/sh
[ -f "$KEG/commands/installation.ts" ] || exit 41
[ "$1" = backup ] || exit 42
printf 'backup\\n' >> "$ORDER"
exit ${backupStatus}
`, { mode: 0o755 });
      fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/sh
printf '%s\\n' "$1" >> "$ORDER"
case "$1" in
  upgrade)
    [ "$HOMEBREW_NO_INSTALL_CLEANUP" = 1 ] || { /bin/rm -rf "$KEG"; exit 43; }
    exit ${upgradeStatus}
    ;;
  cleanup) /bin/rm -rf "$KEG"; exit ${cleanupStatus} ;;
esac
`, { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.ballin'));
      fs.writeFileSync(path.join(home, '.ballin/ballin.config.json'), JSON.stringify({
        update: { cleanup, nvm: false, npm: false, softwareupdate: false, selfUpdate: true, backup: true },
        analytics: { enabled: 'false' },
      }));
      const result = spawnSync(process.execPath, [path.join(first, 'bin/ballin'), 'update'], {
        env: { HOME: home, PATH: tools, NO_COLOR: '1', TERM: 'dumb',
          BALLIN_NO_COMMAND_ANALYTICS: '1', BALLIN_TEST_BALLIN_PATH: backup, KEG: first, ORDER: log },
        encoding: 'utf8', input: '', timeout: 15000,
      });
      assert.equal(result.status, cleanupStatus || backupStatus || upgradeStatus, result.stderr + result.stdout);
      assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
        cleanup && !upgradeStatus && !backupStatus ? ['update', 'upgrade', 'doctor', 'backup', 'cleanup'] : ['update', 'upgrade', 'doctor', 'backup']);
      assert.equal(fs.existsSync(first), !cleanup || Boolean(upgradeStatus || backupStatus));
    });
  }
  for (const [enabled, cleanupStatus, disableDuringCleanup, failVersionCapture] of [
    [true, 0, false, false], [true, 9, false, false], [false, 0, false, false],
    [false, 9, false, false], [true, 0, true, false], [true, 0, false, true],
  ] as const) {
    it(`preserves update analytics after keg retirement (enabled=${enabled}, cleanupStatus=${cleanupStatus}, optOut=${disableDuringCleanup}, versionError=${failVersionCapture})`, () => {
      fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify(receipt(first)));
      const capture = createAnalyticsCapture(root, first);
      if (failVersionCapture) fs.appendFileSync(capture.preloadPath,
        `require(${JSON.stringify(path.join(first, 'commands/analytics.ts'))}).loadAppVersion = () => { throw new Error('fixture version failure'); };`);
      const tools = path.join(root, 'tools');
      fs.mkdirSync(tools);
      fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/sh
if [ "$1" = cleanup ]; then
  /bin/rm -rf "$KEG"
  if [ "$DISABLE_ANALYTICS" = 1 ]; then
    printf '%s\\n' '{"analytics":{"enabled":"false"}}' > "$HOME/.ballin/ballin.config.json"
  fi
  exit ${cleanupStatus}
fi
`, { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.ballin'));
      fs.writeFileSync(path.join(home, '.ballin/ballin.config.json'), JSON.stringify({
        update: { cleanup: true, nvm: false, npm: false, softwareupdate: false, selfUpdate: true, backup: false },
        analytics: { enabled: String(enabled) },
      }));
      const result = spawnSync(process.execPath, [path.join(first, 'bin/ballin'), 'update'], {
        env: { HOME: home, PATH: tools, NO_COLOR: '1', TERM: 'dumb', KEG: first,
          DISABLE_ANALYTICS: disableDuringCleanup ? '1' : '0', ...capture.env },
        encoding: 'utf8', input: '', timeout: 15000,
      });
      assert.equal(result.status, cleanupStatus, result.stderr + result.stdout);
      assert.isFalse(fs.existsSync(first), 'the fixture must retire the invoking keg');
      const events = capture.readEvents();
      assert.lengthOf(events, enabled && !disableDuringCleanup ? 1 : 0);
      if (enabled && !disableDuringCleanup) assert.deepInclude(events[0], {
        schemaVersion: 1, command: 'ballin update', status: cleanupStatus ? 'failure' : 'success',
        appVersion: failVersionCapture ? 'unknown' : 'development', installId: fixtureInstallId,
      });
    });
  }
  it('initializes external preferences then safely cancels setup on EOF', () => {
    const result = run(first, 'setup');
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Review cancelled');
    assert.isTrue(fs.existsSync(path.join(home, '.ballin/ballin.config.json')));
    assert.isFalse(fs.existsSync(path.join(first, 'ballin.config.json')));
  });
});
