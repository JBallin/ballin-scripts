const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createAnalyticsCapture, fixtureInstallId } = require('./helpers/analytics.ts');
const { isHomebrewInstallation, stateDirectory, readPackageMetadata, selectedPackageCommand, homebrewCommandOwner, configurationFile, prepareConfigurationDirectory, packageFormula } = require('../commands/installation.ts');

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
  const stableReceipt = (repo: string) => ({ ...receipt(repo), schema: 3,
    selection: { kind: 'release', value: `v${receipt(repo).version}`, releaseId: '123' },
    runtime: { nodeMajor: 26, minimumNode: '24.12.0' },
  });
  it('recognizes stable package identity without contacting a publication service', () => {
    fs.writeFileSync(path.join(first, '.ballin-package.json'), JSON.stringify(stableReceipt(first)));
    const metadata = readPackageMetadata(first);
    assert.equal(metadata.schema, 3);
    assert.deepEqual(metadata.selection, stableReceipt(first).selection);
    const { loadAppVersion } = require('../commands/analytics.ts');
    assert.equal(loadAppVersion(path.join(first, 'package.json')), receipt(first).version);
    const { collectSetupReadiness } = require('../commands/setup_readiness.ts');
    const report = collectSetupReadiness({ repoDir: first,
      configPath: path.join(home, 'missing-config.json'), env: { HOME: home, PATH: path.join(first, 'bin') },
      runCommand: () => ({ status: 0, stdout: '', stderr: '', signal: null }),
    });
    const provenance = report.checks.find((check: { id: string }) => check.id === 'package.provenance');
    assert.equal(provenance.status, 'info');
    assert.include(provenance.summary, `Release package v${receipt(first).version}`);
    assert.include(provenance.summary, 'installed files are not reverified');
    assert.include(run(first, 'self-update').stdout, 'brew upgrade ballin-experiment');
    assert.include(run(first, 'uninstall').stdout, 'brew uninstall ballin-experiment');
  });
  it('rejects invalid stable publication and runtime contracts without promoting legacy metadata', () => {
    const file = path.join(first, '.ballin-package.json');
    for (const patch of [
      { selection: undefined }, { selection: { kind: 'development' } },
      { selection: { kind: 'release', value: 'v99.0.0', releaseId: '123' } },
      ...[undefined, 123, '0', '01', '-1', 'abc'].map(releaseId => ({
        selection: { kind: 'release', value: `v${receipt(first).version}`, releaseId },
      })),
      { runtime: undefined }, { runtime: { nodeMajor: 0, minimumNode: '24.12.0' } },
      { runtime: { nodeMajor: 26.5, minimumNode: '24.12.0' } },
      { runtime: { nodeMajor: 26, minimumNode: 24 } },
      { runtime: { nodeMajor: 26, minimumNode: '24.13.0' } },
      { runtime: { nodeMajor: 22, minimumNode: '24.12.0' } },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...stableReceipt(first), ...patch }));
      assert.throws(() => readPackageMetadata(first), 'Invalid Ballin stable package provenance');
    }
    const packageFile = path.join(first, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(stableReceipt(first)));
    for (const engines of [undefined, { node: '^24.12.0' }, { node: '>=24.12.1' }]) {
      fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, engines }));
      assert.throws(() => readPackageMetadata(first), 'Invalid Ballin stable package provenance');
    }
    fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, engines: { node: '>=24.12.0' } }));
    assert.equal(readPackageMetadata(first).runtime.minimumNode, '24.12.0');
    for (const ballin of [undefined, { installerProtocol: 2 }, { installerProtocol: 2, packageSchema: 2 }]) {
      fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, ballin }));
      assert.throws(() => readPackageMetadata(first), 'Invalid Ballin stable package provenance');
    }
    fs.writeFileSync(packageFile, JSON.stringify(metadata));
    fs.writeFileSync(file, JSON.stringify({ ...stableReceipt(first), schema: 2 }));
    assert.throws(() => readPackageMetadata(first), 'Invalid Ballin package provenance');
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
  it('rejects unsupported ownership and each malformed provenance field in the source module', () => {
    const marker = path.join(first, '.ballin-package.json');
    for (const value of [null, {}, { manager: 'git', schema: 1 }, { manager: 'homebrew', schema: 4 }]) {
      fs.writeFileSync(marker, JSON.stringify(value));
      assert.throws(() => readPackageMetadata(first), 'Unsupported Ballin package ownership');
    }
    for (const patch of [
      { version: '01.0.0' }, { sourceRevision: 'bad' }, { archiveSha256: 'bad' },
      { formula: '../ballin' }, { selection: undefined }, { commandPath: 42 },
      { commandPath: 'relative/bin/ballin' }, { commandPath: '/bad\nballin' },
      { completionRoot: null }, { completionRoot: 'relative/completions' }, { completionRoot: '/bad\0completions' },
    ]) {
      fs.writeFileSync(marker, JSON.stringify({ ...receipt(first), ...patch }));
      assert.throws(() => readPackageMetadata(first), 'Invalid Ballin package provenance');
    }
    fs.unlinkSync(marker);
    fs.mkdirSync(marker);
    assert.throws(() => readPackageMetadata(first), 'Unable to verify Ballin package ownership');
  });
  it('prepares only the selected package state directory under an isolated home', () => {
    const homedir = os.homedir;
    os.homedir = () => home;
    try {
      const file = path.join(home, '.ballin/ballin.config.json');
      assert.equal(stateDirectory(first), path.dirname(file));
      assert.equal(configurationFile(first), file);
      const unrelated = path.join(root, 'unrelated/ballin.config.json');
      prepareConfigurationDirectory(unrelated, first);
      assert.isFalse(fs.existsSync(path.dirname(unrelated)));
      prepareConfigurationDirectory(file, first);
      assert.isTrue(fs.statSync(path.dirname(file)).isDirectory());
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.isFalse(fs.existsSync(file));
      prepareConfigurationDirectory(file, first);
      prepareConfigurationDirectory(unrelated, root);
      assert.isFalse(fs.existsSync(path.dirname(unrelated)));
      assert.equal(configurationFile(root), path.join(root, 'ballin.config.json'));
      assert.isFalse(fs.existsSync(path.join(first, 'ballin.config.json')));
    } finally { os.homedir = homedir; }
  });
  it('selects the default or recorded formula without writing a source marker', () => {
    const readFileSync = fs.readFileSync;
    const marker = path.join(source, '.ballin-package.json');
    assert.equal(packageFormula(), 'ballin');
    try {
      for (const formula of [undefined, 'owner/tap/ballin-experiment']) {
        fs.readFileSync = (file: string, ...args: unknown[]) => file === marker
          ? JSON.stringify({ manager: 'homebrew', schema: 1, formula }) : readFileSync(file, ...args);
        assert.equal(packageFormula(), formula ?? 'ballin');
      }
    } finally { fs.readFileSync = readFileSync; }
    assert.isFalse(fs.existsSync(marker));
  });
  it('recognizes libexec ownership while distinguishing absent and broken commands', () => {
    assert.isFalse(homebrewCommandOwner(path.join(root, 'missing')));
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync('missing', dangling);
    assert.isFalse(homebrewCommandOwner(dangling));
    const prefix = path.join(root, 'wrapper');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const command = path.join(prefix, 'bin/ballin');
    fs.writeFileSync(command, 'never execute');
    assert.isFalse(homebrewCommandOwner(command));
    fs.mkdirSync(path.join(prefix, 'libexec'));
    fs.writeFileSync(path.join(prefix, 'libexec/.ballin-package.json'), JSON.stringify({ manager: 'homebrew', schema: 1 }));
    assert.isTrue(homebrewCommandOwner(command));
    const realpathSync = fs.realpathSync;
    const denied = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    try {
      fs.realpathSync = (file: string) => { if (file === command) throw denied; return realpathSync(file); };
      assert.throws(() => homebrewCommandOwner(command), 'fixture denied');
    } finally { fs.realpathSync = realpathSync; }
  });
  it('checks legacy ownership, unusable PATH entries, wrappers and retired versions without execution', () => {
    assert.isUndefined(selectedPackageCommand(root, {}));
    assert.equal(selectedPackageCommand(first, {}).status, 'warn');
    const marker = path.join(first, '.ballin-package.json');
    fs.writeFileSync(marker, JSON.stringify(receipt(first)));
    const unusable = path.join(root, 'unusable');
    fs.mkdirSync(path.join(unusable, 'ballin'), { recursive: true });
    assert.equal(selectedPackageCommand(first, { PATH: unusable }).status, 'fail');
    fs.rmdirSync(path.join(unusable, 'ballin'));
    fs.writeFileSync(path.join(unusable, 'ballin'), 'never execute', { mode: 0o600 });
    assert.equal(selectedPackageCommand(first, { PATH: unusable }).status, 'fail');
    const wrapper = path.join(root, 'wrapper');
    fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
    const command = path.join(wrapper, 'bin/ballin');
    fs.writeFileSync(command, 'never execute', { mode: 0o755 });
    fs.symlinkSync(first, path.join(wrapper, 'libexec'));
    fs.writeFileSync(marker, JSON.stringify({ ...receipt(first), commandPath: command }));
    assert.equal(selectedPackageCommand(first, { PATH: path.dirname(command) }).status, 'pass');
    fs.unlinkSync(path.join(wrapper, 'libexec'));
    fs.mkdirSync(path.join(wrapper, 'libexec'));
    assert.include(selectedPackageCommand(first, { PATH: path.dirname(command) }).summary, 'another version');
    fs.unlinkSync(command);
    assert.include(selectedPackageCommand(first, { PATH: path.join(first, 'bin') }).summary, 'cannot be resolved');
  });
  it('collects only explicit package preferences using the original snapshot source', () => {
    const { observeSnapshotSources } = require('../commands/backup_snapshots.ts');
    const preferences = path.join(home, '.ballin/ballin.config.json');
    fs.mkdirSync(path.dirname(preferences));
    fs.mkdirSync(path.join(home, '.ballin-scripts'));
    fs.writeFileSync(path.join(home, '.ballin-scripts/ballin.config.json'), JSON.stringify({ update: { cleanup: 'true' } }));
    fs.writeFileSync(preferences, JSON.stringify({ update: { cleanup: 'false' }, custom: { token: 'PRIVATE_FIXTURE' } }));
    const env = { HOME: home, PATH: '', BALLIN_NO_COMMAND_ANALYTICS: '1' };
    const observe = () => observeSnapshotSources({ homeDir: home, env, configPath: preferences }, false)
      .find((item: { definition: { name: string } }) => item.definition.name === 'ballin_config');
    const snapshot = observe();
    assert.equal(snapshot.status, 'available');
    assert.equal(snapshot.source.path, preferences);
    const result = spawnSync(snapshot.collector.command, snapshot.collector.args, {
      cwd: snapshot.collector.cwd, env: snapshot.collector.env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { update: { cleanup: 'false' } });
    assert.notInclude(result.stdout, 'PRIVATE_FIXTURE');
    fs.unlinkSync(preferences);
    assert.equal(observe().status, 'absent');
    fs.mkdirSync(preferences);
    assert.equal(observe().status, 'unavailable');
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
