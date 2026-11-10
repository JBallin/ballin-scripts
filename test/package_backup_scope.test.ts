const fs = require('fs') as typeof import('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
const { packageScopeFingerprint, packageScopeReceiptName } = require('../commands/package_backup_scope.ts');
const bundledScope = require('../commands/backup_scope.json');
const source = path.join(__dirname, '..');

describe('package backup-scope notices', function() {
  this.timeout(15000);
  let root: string; let home: string; let repo: string; let state: string; let receipt: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-package-scope-'));
    home = path.join(root, 'home'); repo = path.join(root, 'keg'); state = path.join(home, '.ballin');
    receipt = path.join(state, packageScopeReceiptName);
    fs.mkdirSync(home); fs.mkdirSync(path.join(repo, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ballin-package.json'), JSON.stringify({ manager: 'homebrew', schema: 1 }));
    fs.writeFileSync(path.join(repo, 'commands/backup_scope.json'), JSON.stringify(bundledScope));
  });
  afterEach(() => { if (fs.existsSync(state)) fs.chmodSync(state, 0o700); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (sensitive = false) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(source, 'commands/package_backup_scope.ts'))}).notifyPackageBackupScope(${sensitive}, process.argv[1])`, repo], {
    cwd: home, encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: '', TMPDIR: root }),
  });
  const seed = (text: string) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(receipt, text); };
  it('notifies once, records private state, and reminds sensitive-enabled users of continuing scope', () => {
    const first = run(true);
    assert.equal(first.status, 0, first.stderr);
    assert.include(first.stdout, 'First backup-scope notice');
    assert.include(first.stdout, 'current and future supported sources');
    assert.include(first.stdout, 'getballin.com/docs/backup-sources.html');
    assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(receipt, 'utf8'), `v1:${packageScopeFingerprint(bundledScope)}\n`);
    assert.equal(run(true).stdout, '');
    assert.deepEqual(fs.readdirSync(state), [packageScopeReceiptName]);
  });
  it('detects changed bundled scope after external replacement without inventing consent', () => {
    run();
    fs.writeFileSync(path.join(repo, 'commands/backup_scope.json'), JSON.stringify({ ...bundledScope, collectionPolicy: 2 }));
    const changed = run();
    assert.include(changed.stdout, 'scope changed');
    assert.notInclude(changed.stdout, 'opt-in');
    assert.equal(run().stdout, '');
  });
  it('normalizes unordered catalog fields but preserves path and source argument order', () => {
    const reordered = structuredClone(bundledScope);
    reordered.sources.reverse(); reordered.portableUpdateKeys.reverse();
    for (const key of ['excludedNames', 'claudeSyncBookkeeping', 'claudeExcludedRoots']) reordered.recursive[key].reverse();
    const reversedKeys = Object.fromEntries(Object.entries(reordered).reverse());
    assert.equal(packageScopeFingerprint(reversedKeys), packageScopeFingerprint(bundledScope));
    run(); fs.writeFileSync(path.join(repo, 'commands/backup_scope.json'), JSON.stringify(reversedKeys));
    assert.equal(run().stdout, '');
    reordered.roots.editor.reverse();
    assert.notEqual(packageScopeFingerprint(reordered), packageScopeFingerprint(bundledScope));
    reordered.roots.editor.reverse(); reordered.sources[0].reverse();
    assert.notEqual(packageScopeFingerprint(reordered), packageScopeFingerprint(bundledScope));
  });
  it('does nothing for direct/legacy Git installs', () => {
    fs.unlinkSync(path.join(repo, '.ballin-package.json'));
    const result = run(true);
    assert.equal(result.stdout + result.stderr, '');
    assert.isFalse(fs.existsSync(state));
  });
  it('reports malformed receipts as unavailable, then replaces them with known notification state', () => {
    for (const text of ['bad', 'v2:' + 'a'.repeat(64) + '\n']) {
      seed(text);
      const result = run();
      assert.include(result.stdout, 'Unable to compare');
      assert.equal(result.stderr, '');
      assert.equal(run().stdout, '');
    }
  });
  it('does not follow a receipt symlink and repeats after failed recording', () => {
    fs.mkdirSync(state);
    const target = path.join(root, 'target'); fs.writeFileSync(target, 'fixture'); fs.symlinkSync(target, receipt);
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.include(result.stdout, 'Unable to compare');
      assert.include(result.stderr, 'Backup will continue');
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'fixture');
    assert.isTrue(fs.lstatSync(receipt).isSymbolicLink());
  });
  it('refuses linked state directories and multiply linked receipts without changing targets', () => {
    const target = path.join(root, 'other-state'); fs.mkdirSync(target);
    fs.symlinkSync(target, state);
    assert.include(run().stderr, 'this notice may repeat');
    assert.deepEqual(fs.readdirSync(target), []);
    fs.unlinkSync(state); fs.mkdirSync(state);
    const file = path.join(target, 'receipt'); fs.writeFileSync(file, 'original'); fs.linkSync(file, receipt);
    assert.include(run().stderr, 'this notice may repeat');
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  });
  it('warns and repeats when a state directory or receipt cannot be written', () => {
    fs.mkdirSync(state); fs.chmodSync(state, 0o500);
    assert.include(run().stderr, 'this notice may repeat');
    assert.include(run().stdout, 'First backup-scope notice');
    fs.chmodSync(state, 0o700); seed('bad'); fs.chmodSync(receipt, 0o400);
    assert.include(run().stderr, 'this notice may repeat');
    fs.chmodSync(receipt, 0o600);
  });
  it('reports a missing or malformed catalog without claiming a comparison or recording it', () => {
    for (const value of ['bad', '{}']) {
      fs.writeFileSync(path.join(repo, 'commands/backup_scope.json'), value);
      assert.include(run().stderr, 'scope changes could not be compared');
      assert.isFalse(fs.existsSync(receipt));
    }
    fs.unlinkSync(path.join(repo, 'commands/backup_scope.json'));
    assert.include(run().stderr, 'scope changes could not be compared');
  });
  it('notifies before real fixture collection; repeated backup and read-only inventory do not repeat', () => {
    for (const name of ['commands', 'config', 'bin', 'package.json']) fs.cpSync(path.join(source, name), path.join(repo, name), { recursive: true });
    const tools = path.join(root, 'tools'); fs.mkdirSync(tools); fs.mkdirSync(state);
    const remote = path.join(root, 'remote.json'); fs.writeFileSync(remote, JSON.stringify(fixtureState()));
    installRepositoryFixture(tools, remote);
    fs.writeFileSync(path.join(state, 'ballin.config.json'), JSON.stringify({ backup: { repository: fixtureDestination, includeSensitive: false } }));
    const backup = (...args: string[]) => spawnSync(process.execPath, [path.join(repo, 'bin/ballin'), 'backup', ...args], {
      cwd: home, input: '', encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: tools, TMPDIR: root, BALLIN_TEST_CONFIG_PATH: path.join(state, 'ballin.config.json'), BALLIN_TEST_REPO_DIR: undefined }),
    });
    assert.notInclude(backup('list').stdout, 'backup-scope notice');
    assert.isFalse(fs.existsSync(receipt));
    const first = backup();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.include(first.stdout, 'First backup-scope notice');
    assert.isBelow(first.stdout.indexOf('First backup-scope notice'), first.stdout.indexOf('+ ballin_config'));
    const next = backup();
    assert.equal(next.status, 0, next.stderr);
    assert.notInclude(next.stdout, 'backup-scope notice');
    fs.unlinkSync(receipt); fs.mkdirSync(receipt);
    const failedReceipt = backup();
    assert.equal(failedReceipt.status, 0, failedReceipt.stderr);
    assert.include(failedReceipt.stderr, 'Backup will continue');
    const data = JSON.parse(fs.readFileSync(remote, 'utf8'));
    assert.notProperty(data.commits[data.head].files, packageScopeReceiptName);
    assert.isFalse(fs.existsSync(path.join(repo, packageScopeReceiptName)));
  });
});
