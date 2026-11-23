const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { loadAppVersion } = require('../commands/analytics.ts');
const { testChildEnvironment, withEnvironment } = require('./helpers/environment.ts');

describe('analytics release version lookup', () => {
  let root: string;
  let head: string;
  const spawnSync = cp.spawnSync;
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: testChildEnvironment({
      HOME: root, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }) });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const receipt = (extra = {}) => ({ kind: 'release', value: 'v1.0.0', sha: head, minimumNode: '24.12.0', releaseId: '123', ...extra });
  const save = (extra = {}, file = path.join(root, '.git/ballin-install.json')) => fs.writeFileSync(file, JSON.stringify(receipt(extra)));
  const version = (directory = root) => withEnvironment({ HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    () => loadAppVersion(path.join(directory, 'package.json')));
  const trackGit = (): string[][] => {
    const calls: string[][] = [];
    cp.spawnSync = (command: string, args: string[], options: { cwd?: string }) => {
      if (command === 'git') calls.push(args);
      return spawnSync(command, args, options);
    };
    return calls;
  };
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-version-')));
    git('init', '-q'); fs.writeFileSync(path.join(root, 'tracked'), 'original\n');
    git('add', 'tracked'); git('commit', '-qm', 'fixture'); head = git('rev-parse', 'HEAD');
  });
  afterEach(() => { cp.spawnSync = spawnSync; fs.rmSync(root, { recursive: true, force: true }); });

  for (const state of ['missing', 'malformed', 'invalid', 'oversized', 'linked', 'directory', 'branch', 'sha', 'stale']) {
    it(`avoids checkout inspection for a ${state} release receipt`, () => {
      const file = path.join(root, '.git/ballin-install.json');
      if (state === 'malformed') fs.writeFileSync(file, '{');
      else if (state === 'invalid') save({ releaseId: '-' });
      else if (state === 'oversized') fs.writeFileSync(file, JSON.stringify(receipt()) + ' '.repeat(4097));
      else if (state === 'linked') { save({}, file + '.target'); fs.symlinkSync(file + '.target', file); }
      else if (state === 'directory') fs.mkdirSync(file);
      else if (state === 'branch') save({ kind: 'branch', value: 'main', releaseId: '-' });
      else if (state === 'sha') save({ kind: 'sha', value: head, releaseId: '-' });
      else if (state === 'stale') save({ sha: 'a'.repeat(40) });
      const calls = trackGit();
      assert.equal(version(), 'development');
      assert.isAtMost(calls.length, 2);
      assert.isTrue(calls.every(args => args[0] === 'rev-parse'), JSON.stringify(calls));
    });
  }
  for (const state of ['clean', 'dirty', 'hidden index', 'sparse', 'replacement', 'missing tag', 'wrong tag']) {
    it(`fully validates a matching release receipt (${state})`, () => {
      git('tag', 'v1.0.0'); save();
      if (state === 'dirty' || state === 'hidden index') fs.writeFileSync(path.join(root, 'tracked'), 'modified\n');
      if (state === 'hidden index') git('update-index', '--assume-unchanged', 'tracked');
      if (state === 'sparse') git('config', 'core.sparseCheckout', 'true');
      if (state === 'replacement') git('update-ref', 'refs/replace/' + head, head);
      if (state === 'missing tag') git('tag', '-d', 'v1.0.0');
      if (state === 'wrong tag') {
        fs.writeFileSync(path.join(root, 'tracked'), 'next\n'); git('commit', '-am', 'next');
        git('tag', 'v1.0.0', '-f'); git('checkout', '--detach', head);
      }
      const calls = trackGit();
      assert.equal(version(), state === 'clean' ? '1.0.0' : 'development');
      assert.isTrue(calls.some(args => args[0] === 'status'), JSON.stringify(calls));
    });
  }
  it('uses each worktree receipt instead of a shared or guessed .git path', () => {
    git('tag', 'v1.0.0');
    const linked = path.join(root, 'linked'); git('worktree', 'add', '--detach', linked, 'HEAD');
    save({}, path.join(git('-C', linked, 'rev-parse', '--absolute-git-dir'), 'ballin-install.json'));
    assert.equal(version(linked), '1.0.0'); assert.equal(version(), 'development');
  });
  it('does not cache a version across an update, receipt change or dirty edit', () => {
    git('tag', 'v1.0.0'); save(); assert.equal(version(), '1.0.0');
    fs.writeFileSync(path.join(root, 'tracked'), 'updated\n'); git('commit', '-am', 'updated');
    head = git('rev-parse', 'HEAD'); git('tag', 'v1.1.0');
    assert.equal(version(), 'development');
    save({ value: 'v1.1.0' }); assert.equal(version(), '1.1.0');
    fs.writeFileSync(path.join(root, 'tracked'), 'local edit\n'); assert.equal(version(), 'development');
  });
  it('returns unknown when HEAD cannot be resolved, rather than inventing a development identity', () => {
    assert.equal(version(path.join(root, 'absent')), 'unknown');
    cp.spawnSync = () => ({ status: 0, stdout: 'invalid\n', stderr: '' });
    assert.equal(version(), 'unknown');
  });
  for (const step of ['HEAD', 'receipt', 'status']) for (const status of [1, 130, 143]) {
    it(`retains failure and interruption behavior at ${step} (${status})`, () => {
      git('tag', 'v1.0.0'); save();
      cp.spawnSync = (command: string, args: string[], options: unknown) => {
        const matches = step === 'HEAD' ? args.includes('HEAD') : step === 'receipt' ? args.includes('--absolute-git-dir') : args[0] === 'status';
        return command === 'git' && matches ? { status, stdout: '', stderr: 'fixture failure' } : spawnSync(command, args, options);
      };
      if (status === 1) assert.equal(version(), step === 'receipt' ? 'development' : 'unknown');
      else assert.throws(() => version(), 'interrupted');
    });
  }
});
