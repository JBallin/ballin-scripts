const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateSelection, checkRuntime, compareVersions, needsConsent, readIdentity, assertSafeCheckout } = require('../commands/repo_update.ts');

describe('revision selection and checkout safety', () => {
  const sha = 'a'.repeat(40);
  const selection = { kind: 'release', value: 'v1.0.0', sha, minimumNode: '24.12.0', releaseId: '123' };
  it('validates the resolved selection, not package version guesses', () => {
    validateSelection(selection);
    for (const invalid of [ { ...selection, sha: 'main' }, { ...selection, releaseId: '-' }, { ...selection, kind: 'sha' }, { ...selection, minimumNode: '>=24' } ]) {
      assert.throws(() => validateSelection(invalid));
    }
    validateSelection({ ...selection, kind: 'sha', value: sha, releaseId: '-' });
  });
  it('refuses insufficient and prerelease Node before checkout work', () => {
    checkRuntime('24.12.0', '26.13.0'); checkRuntime('24.12.0', '24.12.0');
    for (const actual of ['24.11.9', '22.0.0', '24.12.0-rc.1', 'invalid']) assert.throws(() => checkRuntime('24.12.0', actual), 'Upgrade or activate Node');
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  });
  it('requires consent for major, downgrade, unknown and track changes', () => {
    const before = { sha: 'b'.repeat(40), kind: 'release', value: 'v1.0.0', version: '1.0.0' };
    assert.isFalse(needsConsent(before, { ...selection, value: 'v1.1.0' }, 'self-update'));
    for (const value of ['v2.0.0', 'v0.9.0']) assert.isTrue(needsConsent(before, { ...selection, value }, 'self-update'));
    assert.isTrue(needsConsent({ ...before, kind: undefined }, selection, 'self-update'));
    assert.isTrue(needsConsent(before, selection, 'install'));
    assert.isFalse(needsConsent({ ...before, sha }, selection, 'install'));
  });
  let root: string;
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-revision-test-'));
    git('init', '-q'); fs.writeFileSync(path.join(root, 'tracked'), 'original\n'); git('add', 'tracked'); git('commit', '-qm', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/JBallin/ballin-scripts.git');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('accepts a clean checkout and never repairs a dirty checkout', () => {
    const head = assertSafeCheckout(root);
    fs.writeFileSync(path.join(root, 'tracked'), 'local work\n');
    assert.throws(() => assertSafeCheckout(root), 'local changes');
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(root, 'tracked'), 'utf8'), 'local work\n');
    assert.include(readIdentity(root).label, '(dirty)');
  });
  it('rejects conflicts and hidden index state', () => {
    fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), sha);
    assert.throws(() => assertSafeCheckout(root), 'MERGE_HEAD');
    fs.unlinkSync(path.join(root, '.git', 'MERGE_HEAD'));
    git('update-index', '--assume-unchanged', 'tracked');
    assert.throws(() => assertSafeCheckout(root), 'hidden index');
  });
  it('does not equate a tag with a published release or explicit SHA install', () => {
    const head = git('rev-parse', 'HEAD'); git('tag', 'v1.0.0');
    assert.equal(readIdentity(root).version, 'development');
    const receipt = path.join(root, '.git', 'ballin-install.json');
    fs.writeFileSync(receipt, JSON.stringify({ ...selection, sha: head }));
    assert.equal(readIdentity(root).version, '1.0.0');
    fs.writeFileSync(receipt, JSON.stringify({ ...selection, sha: head, kind: 'sha', value: head, releaseId: '-' }));
    assert.equal(readIdentity(root).version, 'development');
    fs.writeFileSync(receipt, JSON.stringify(selection));
    assert.equal(readIdentity(root).version, 'development');
  });
  it('uses per-worktree Git metadata rather than assuming .git is a directory', () => {
    const linked = path.join(root, 'linked'); git('worktree', 'add', '--detach', linked, 'HEAD');
    assert.equal(readIdentity(linked).sha, git('rev-parse', 'HEAD'));
  });
  it('refuses an unprotected detached commit until the user gives it a branch', () => {
    git('checkout', '--detach'); fs.writeFileSync(path.join(root, 'tracked'), 'local commit\n'); git('commit', '-am', 'local work');
    const head = git('rev-parse', 'HEAD');
    assert.throws(() => assertSafeCheckout(root), 'unprotected work'); assert.equal(git('rev-parse', 'HEAD'), head);
    git('branch', 'saved-work'); assert.equal(assertSafeCheckout(root), head);
  });
  it('refuses an unexpected origin, a nested destination, or a symlink', () => {
    git('remote', 'set-url', 'origin', 'https://example.invalid/not-ballin');
    assert.throws(() => assertSafeCheckout(root), 'origin');
    git('remote', 'set-url', 'origin', 'https://github.com/JBallin/ballin-scripts.git');
    const nested = path.join(root, 'nested'); fs.mkdirSync(nested); assert.throws(() => assertSafeCheckout(nested), 'repository root');
    const linked = path.join(root, 'linked'); fs.symlinkSync(nested, linked); assert.throws(() => assertSafeCheckout(linked), 'real directory');
  });
});
