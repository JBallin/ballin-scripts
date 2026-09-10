const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
const { repositoryCacheDirectory } = require('../commands/backup_repository.ts');
const { configuredBackupDestination, sensitiveSourceConsent } = require('../commands/backup_config.ts');
import type { FixtureState } from './helpers/repository.ts';

const repoRoot = path.join(__dirname, '..');
describe('repository backup lifecycle', function() {
  this.timeout(15000);
  let root: string; let home: string; let bin: string; let checkout: string;
  let configPath: string; let statePath: string; let cacheRoot: string; let cache: string;
  const state = (): FixtureState => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const saveState = (value: FixtureState): void => fs.writeFileSync(statePath, JSON.stringify(value));
  const config = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const saveConfig = (value: unknown): void => fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  const mutations = () => state().requests.filter((r) => r.endpoint === 'user/repos' || r.payload?.query?.includes('BallinPublish'));
  const publications = () => mutations().filter((r) => r.endpoint === 'graphql');
  const remote = (name: string): string | undefined => {
    const value = state(); const content = value.commits[value.head].files[name];
    return content === undefined ? undefined : Buffer.from(content, 'base64').toString();
  };
  const cached = (name = 'zshrc.sh'): string | undefined => (
    fs.existsSync(path.join(cache, name)) ? fs.readFileSync(path.join(cache, name), 'utf8') : undefined
  );
  const seedCache = (name: string, contents: string): void => {
    fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, name), contents);
  };
  const source = (contents = 'local\n'): void => fs.writeFileSync(path.join(home, '.zshrc'), contents);
  const unconfigured = (): void => { const value = config(); value.backup.repository = null; saveConfig(value); };
  const run = (args: string[] = [], input = '', env: NodeJS.ProcessEnv = {}, preload = '') => {
    const preloadPath = path.join(root, 'preload.cjs');
    fs.writeFileSync(preloadPath, preload);
    return spawnSync(process.execPath, ['--require', preloadPath, path.join(repoRoot, 'bin', 'ballin'), 'backup', ...args], {
      encoding: 'utf8', input, cwd: checkout, env: testChildEnvironment({
        HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'),
        BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout, ...env,
      }),
    });
  };
  const ok = (result: { status: number; stdout: string; stderr: string }): void => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const cacheFailure = (method: string, condition: string): string => `
    const fs = require('fs'); const original = fs.${method};
    fs.${method} = function(...args) { if (${condition}) throw new Error('fixture failure'); return original.apply(this, args); };
  `;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-repository-test-'));
    home = path.join(root, 'home'); bin = path.join(root, 'bin'); checkout = path.join(home, '.ballin-scripts');
    [home, bin, checkout, path.join(root, 'tmp')].forEach((directory) => fs.mkdirSync(directory));
    fs.cpSync(path.join(repoRoot, 'config'), path.join(checkout, 'config'), { recursive: true });
    configPath = path.join(checkout, 'ballin.config.json'); statePath = path.join(root, 'remote.json');
    cacheRoot = path.join(checkout, '.backup-cache'); cache = repositoryCacheDirectory(cacheRoot, fixtureDestination);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
    const defaults = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', '.defaultConfig.json'), 'utf8'));
    defaults.backup.repository = fixtureDestination; defaults.backup.includeSensitive = 'true'; defaults.analytics.enabled = 'false';
    saveConfig(defaults); saveState(fixtureState()); installRepositoryFixture(bin, statePath);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  [
    { base: undefined, remote: undefined, local: 'local\n', publish: true },
    { base: undefined, remote: 'local\n', local: 'local\n', publish: false },
    { base: undefined, remote: 'other\n', local: 'local\n', conflict: true },
    { base: 'base\n', remote: undefined, local: 'local\n', conflict: true },
    { base: 'base\n', remote: 'base\n', local: 'local\n', publish: true },
    { base: 'same\n', remote: 'same\n', local: 'same\n', publish: false },
    { base: 'base\n', remote: 'local\n', local: 'local\n', publish: false },
    { base: 'base\n', remote: 'other\n', local: 'local\n', conflict: true },
  ].forEach((row, index) => {
    it(`preserves the three-way reconciliation decision ${index + 1}`, () => {
      source(row.local);
      if (row.base !== undefined) seedCache('zshrc.sh', row.base);
      saveState(fixtureState(row.remote === undefined ? {} : { 'zshrc.sh': row.remote }));
      const before = state().head; const result = run();
      assert.equal(result.status, row.conflict ? 1 : 0, result.stdout + result.stderr);
      if (row.conflict) {
        assert.include(result.stderr, 'conflict for zshrc.sh'); assert.equal(state().head, before);
        assert.equal(cached(), row.base); assert.equal(mutations().length, 0);
      } else {
        assert.equal(remote('zshrc.sh'), row.local); assert.equal(cached(), row.local);
        // The fixed preferences baseline also needs its first capture.
        const additions = publications()[0]?.payload?.variables?.input as { fileChanges: { additions: { path: string }[] } };
        assert.equal(additions.fileChanges.additions.some((item) => item.path === 'zshrc.sh'), !!row.publish);
        ok(run()); assert.equal(publications().length, 1);
      }
    });
  });
  it('reports every conflict and aborts all publication and cache promotion', () => {
    source(); fs.writeFileSync(path.join(home, '.gitconfig'), 'local git\n');
    saveState(fixtureState({ 'zshrc.sh': 'other\n', gitconfig: 'other git\n' }));
    const result = run(); assert.equal(result.status, 1);
    assert.include(result.stderr, 'conflict for zshrc.sh'); assert.include(result.stderr, 'conflict for gitconfig');
    assert.equal(mutations().length, 0); assert.isFalse(fs.existsSync(cache));
  });
  it('retains excluded and unavailable sources without using a legacy cache as a base', () => {
    const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
    source(); fs.mkdirSync(cacheRoot); fs.writeFileSync(path.join(cacheRoot, 'zshrc.sh'), 'other\n');
    seedCache('zshrc.sh', 'old\n'); seedCache('pipx', 'old pipx\n');
    saveState(fixtureState({ 'zshrc.sh': 'other\n', pipx: 'retained pipx\n' }));
    ok(run()); assert.equal(remote('zshrc.sh'), 'other\n'); assert.equal(cached(), 'old\n');
    assert.equal(remote('pipx'), 'retained pipx\n');
    value.backup.includeSensitive = true; saveConfig(value);
    assert.equal(run().status, 1); assert.equal(publications().length, 1);
  });
  it('preserves normalization and legacy empty bytes while handling same-size local changes', () => {
    source('same'); ok(run()); assert.equal(remote('zshrc.sh'), 'same\n');
    source('size\n'); ok(run()); assert.equal(remote('zshrc.sh'), 'size\n');
    source(''); ok(run()); assert.equal(remote('zshrc.sh'), 'empty\n'); ok(run());
    assert.equal(publications().length, 3);
  });
  it('aborts before remote reads for collector failure or invalid portable projection', () => {
    source(); fs.rmSync(path.join(bin, 'cat')); fs.writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    assert.equal(run().status, 1); assert.equal(state().requests.length, 0);
    const value = config(); value.update.npm = 'invalid'; saveConfig(value);
    assert.equal(run().status, 1); assert.equal(state().requests.length, 0);
  });
  ['true-ish', null, 1, {}].forEach((consent) => {
    it(`rejects invalid consent before discovery: ${JSON.stringify(consent)}`, () => {
      const value = config(); value.backup.includeSensitive = consent; saveConfig(value);
      fs.symlinkSync(path.join(home, '.zshrc'), path.join(home, '.zshrc'));
      assert.include(run().stderr, 'invalid backup.includeSensitive'); assert.equal(state().requests.length, 0);
    });
  });
  ['ambiguous', 'malformed'].forEach((mode) => {
    it(`confirms ${mode} publication and never duplicates it on the next run`, () => {
      source(); const value = state(); value.faults.publish = mode; saveState(value);
      ok(run()); ok(run()); assert.equal(publications().length, 1); assert.equal(cached(), 'local\n');
    });
  });
  ['advance', 'denied', 'orphan', 'wrong-readback'].forEach((mode) => {
    it(`leaves comparison bytes intact after ${mode}`, () => {
      source(); seedCache('zshrc.sh', 'base\n'); const value = fixtureState({ 'zshrc.sh': 'base\n' });
      value.faults.publish = mode; saveState(value);
      assert.equal(run().status, 1); assert.equal(cached(), 'base\n'); assert.equal(publications().length, 1);
    });
  });
  ['chmodSync', 'renameSync'].forEach((method) => {
    it(`reports confirmed remote success and recovers without another commit after cache ${method} failure`, () => {
      source(); const result = run([], '', {}, cacheFailure(method,
        "String(args[0]).includes('.ballin-backup-cache-') && String(args[0]).endsWith('zshrc.sh')"));
      assert.equal(result.status, 1); assert.include(result.stderr, 'publication confirmed');
      assert.notMatch(result.stdout, /[✔✚✎]/u); assert.isUndefined(cached());
      ok(run()); assert.equal(publications().length, 1); assert.equal(cached(), 'local\n');
    });
  });
  it('keeps caches unpromoted when preparing private cache copies fails', () => {
    source(); const result = run([], '', {}, cacheFailure('copyFileSync', "String(args[1]).includes('.ballin-backup-cache-')"));
    assert.equal(result.status, 1); assert.include(result.stderr, 'publication confirmed'); assert.isUndefined(cached());
    ok(run()); assert.equal(publications().length, 1);
  });
  it('retains confirmed effects while reporting failed staging cleanup without success markers', () => {
    source(); const result = run([], '', {}, cacheFailure('rmSync', "String(args[0]).includes('.ballin-backup-cache-')"));
    assert.equal(result.status, 1); assert.include(result.stderr, 'publication confirmed'); assert.equal(cached(), 'local\n');
    assert.notMatch(result.stdout, /[✔✚✎]/u); ok(run()); assert.equal(publications().length, 1);
  });
  it('reports failed temporary-file cleanup without masking confirmed effects', () => {
    source('base\n'); ok(run()); source();
    const result = run([], '', {}, cacheFailure('rmSync', "String(args[0]).includes('ballin-backup-remote-')"));
    assert.equal(result.status, 1); assert.include(result.stderr, 'temporary-file cleanup is incomplete');
    assert.equal(cached(), 'local\n'); assert.notMatch(result.stdout, /[✔✚✎]/u);
  });
  it('reports a confirmed no-op separately when hydrating the missing cache fails', () => {
    source(); ok(run()); fs.rmSync(cache, { recursive: true });
    const result = run([], '', {}, cacheFailure('copyFileSync', "String(args[1]).includes('.ballin-backup-cache-')"));
    assert.equal(result.status, 1); assert.include(result.stderr, 'state confirmed unchanged');
    assert.equal(publications().length, 1); ok(run()); assert.equal(publications().length, 1);
  });
  it('creates private cache ancestors and files under a permissive umask', () => {
    source(); ok(run([], '', {}, 'process.umask(0);'));
    assert.equal(fs.statSync(cacheRoot).mode & 0o777, 0o700); assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(cache, 'zshrc.sh')).mode & 0o777, 0o600);
    fs.chmodSync(cacheRoot, 0o755); fs.chmodSync(cache, 0o755); fs.chmodSync(path.join(cache, 'zshrc.sh'), 0o644);
    ok(run()); assert.equal(fs.statSync(cacheRoot).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(cache, 'zshrc.sh')).mode & 0o777, 0o600);
  });
  it('rejects cache symlinks before any remote operation without touching their targets', () => {
    fs.symlinkSync(home, cacheRoot); assert.equal(run().status, 1); assert.equal(state().requests.length, 0);
    assert.equal(fs.statSync(home).mode & 0o777, 0o755);
  });
  it('reads exact bytes and opens the validated renamed repository with read-only credentials and no cache changes', () => {
    const bytes = 'no execution $(touch forbidden)\r\n\n'; const value = fixtureState({ 'zshrc.sh': bytes });
    value.name = 'renamed'; value.faults.publish = 'denied'; saveState(value);
    fs.symlinkSync(home, cacheRoot);
    assert.equal(run(['read', 'zshrc.sh']).stdout, bytes); ok(run(['open']));
    assert.isTrue(fs.lstatSync(cacheRoot).isSymbolicLink()); assert.equal(mutations().length, 0);
    assert.equal(run(['read', '.ballin-backup.json']).status, 1);
    assert.equal(run(['read', 'nonexistent']).status, 1);
    const failed = state(); failed.faults.tree = { truncated: true }; saveState(failed);
    assert.equal(run(['read', 'zshrc.sh']).status, 1);
  });
  it('renders repository readiness failure with repository-appropriate recovery guidance', () => {
    const value = state(); value.faults.auth = true; saveState(value);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'doctor'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(result.status, 1); assert.include(result.stdout, 'ballin backup setup to revalidate');
    assert.notInclude(result.stdout, 'Gist'); assert.equal(mutations().length, 0);
  });

  it('creates and confirms only the marker before persisting reviewed local choices', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n\n'); ok(result);
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.equal(config().backup.includeSensitive, 'false');
    assert.equal(config().update.backup, 'true'); assert.deepEqual(Object.keys(state().commits[state().head].files), ['.ballin-backup.json']);
    assert.isFalse(fs.existsSync(cacheRoot)); assert.equal(mutations().length, 2);
    assert.isBelow(result.stdout.indexOf('Selected GitHub.com account: fixture-user'), result.stdout.indexOf('Confirm this destination'));
    assert.notInclude(result.stdout, 'zshrc.sh:');
  });
  it('does not persist initially absent destination or consent fields during cancelled review', () => {
    const value = config(); delete value.backup.repository; delete value.backup.includeSensitive; saveConfig(value);
    const result = run(['setup'], 'y\nreconnect\n\nn\ny'); assert.equal(result.status, 1);
    assert.deepEqual(config(), value); assert.equal(mutations().length, 0);
  });
  it('preserves an unowned configuration temporary file after exclusive creation fails', () => {
    const result = run(['disconnect'], '', {}, `require('fs').writeFileSync(${JSON.stringify(configPath)} + '.' + process.pid + '.backup.tmp', 'preexisting');`);
    assert.equal(result.status, 1); assert.deepEqual(config().backup.repository, fixtureDestination);
    const staged = fs.readdirSync(checkout).find((name: string) => name.endsWith('.backup.tmp'));
    assert.equal(fs.readFileSync(path.join(checkout, staged), 'utf8'), 'preexisting');
  });
  it('handles config staging cleanup failure after a successful disconnect commit', () => {
    const result = run(['disconnect'], '', {}, cacheFailure('rmSync', "String(args[0]).endsWith('.backup.tmp')"));
    ok(result); assert.include(result.stdout, 'Unable to remove a private backup configuration staging file');
    assert.isNull(config().backup.repository);
  });
  ['y\n', 'y\ncreate', 'y\ncreate\n', 'y\ncreate\n\n', 'y\ncreate\n\nn', 'y\ncreate\n\nn\n', 'y\ncreate\n\nn\ny', 'y\ncreate\n\nn\nn\n'].forEach((input) => {
    it(`cancels setup with no destination, consent, cache, or remote changes at ${JSON.stringify(input)}`, () => {
      unconfigured(); const value = state(); value.exists = false; saveState(value); seedCache('zshrc.sh', 'untrusted\n');
      const before = fs.readFileSync(configPath, 'utf8'); const result = run(['setup'], input);
      assert.equal(result.status, 1); assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.equal(mutations().length, 0); assert.equal(cached(), 'untrusted\n');
    });
  });
  ['', 'y', 'n\n'].forEach((input) => {
    it(`leaves a maintenance-only installation usable at the first prompt: ${JSON.stringify(input)}`, () => {
      unconfigured(); ok(run(['setup'], input)); assert.equal(state().requests.length, 0);
      assert.isNull(config().backup.repository); assert.equal(config().update.backup, 'false');
    });
  });
  it('reviews raw symlink targets outside HOME and pipx availability without reading contents or collecting', () => {
    unconfigured(); const external = path.join(root, 'external-config'); fs.writeFileSync(external, 'private-review-secret');
    fs.symlinkSync(external, path.join(home, '.zshrc'));
    const preload = `const fs=require('fs'); for(const method of ['openSync','readFileSync']) {
      const original=fs[method]; fs[method]=function(file,...args){
        if(String(file).endsWith('.zshrc') || String(file).endsWith('external-config'))
          throw new Error('Raw contents must not be read during review');
        return original.call(this,file,...args); }; }`;
    const result = run(['setup'], 'y\nreconnect\n\ny\nn\n', {}, preload); assert.equal(result.status, 1);
    assert.include(result.stdout, JSON.stringify(fs.realpathSync(external))); assert.include(result.stdout, 'pipx: unavailable');
    assert.notInclude(result.stdout, 'private-review-secret'); assert.equal(mutations().length, 0);
    assert.include(result.stdout, 'Confirm this destination');
  });
  it('skips all sensitive discovery after declining and aborts selected inaccessible sources', () => {
    unconfigured(); fs.symlinkSync(path.join(home, '.zshrc'), path.join(home, '.zshrc'));
    const failed = run(['setup'], 'y\nreconnect\n\ny\ny\n'); assert.equal(failed.status, 1);
    assert.include(failed.stdout, 'source access failed'); assert.equal(mutations().length, 0);
    ok(run(['setup'], 'y\nreconnect\n\nn\ny\nn\n'));
  });
  it('rejects resolution failure or missing HOME during selected sensitive review', () => {
    unconfigured(); source();
    const failed = run(['setup'], 'y\nreconnect\n\ny\n', {}, cacheFailure('realpathSync', "String(args[0]).endsWith('.zshrc')"));
    assert.equal(failed.status, 1); assert.include(failed.stdout, 'resolution or read access failed');
    const missing = run(['setup'], 'y\nreconnect\n\ny\n', { HOME: undefined });
    assert.equal(missing.status, 1); assert.include(missing.stdout, 'HOME is required'); assert.equal(mutations().length, 0);
  });
  it('rejects invalid names, wrong owners, and invalid recovered preference snapshots before confirmation', () => {
    unconfigured(); assert.equal(run(['setup', 'owner/repo']).status, 1); assert.equal(state().requests.length, 0);
    assert.equal(run(['setup'], 'y\nreconnect\nwrong/name\n').status, 1);
    const value = state(); value.faults.user = { type: 'Organization' }; saveState(value);
    assert.equal(run(['setup'], 'y\nreconnect\n\n').status, 1);
    for (const content of ['invalid JSON', '[]']) {
      saveState(fixtureState({ ballin_config: content }));
      assert.equal(run(['setup'], 'y\nreconnect\n\nn\ny\n').status, 1); assert.equal(mutations().length, 0);
    }
  });
  it('revalidates after final confirmation and refuses a moved reconnect candidate', () => {
    unconfigured(); const preload = `const fs=require('fs'); const original=process.stdout.write;
      process.stdout.write=function(chunk,...args){ if(String(chunk).startsWith('Confirm this destination')) {
        const file=${JSON.stringify(statePath)}; const state=JSON.parse(fs.readFileSync(file));
        require(${JSON.stringify(path.join(__dirname, 'helpers', 'repository.ts'))}).commitFixture(state, state.commits[state.head].files);
        fs.writeFileSync(file,JSON.stringify(state));
      } return original.call(this,chunk,...args); };`;
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\n', {}, preload);
    assert.equal(result.status, 1); assert.include(result.stdout, 'changed during inspection');
    assert.isNull(config().backup.repository); assert.equal(mutations().length, 0);
  });
  it('reconnects without write permission or a cached base and restores only eligible preferences with local precedence', () => {
    const local = { backup: { id: null, host: 'preserved.test', repository: null, includeSensitive: 'true' },
      update: { cleanup: 'invalid', npm: false }, analytics: {}, custom: { preserve: true } };
    saveConfig(local); seedCache('zshrc.sh', 'stale base\n');
    const value = fixtureState({ ballin_config: JSON.stringify({ update: { cleanup: true, npm: true, nvm: false, selfUpdate: 'false', softwareupdate: true, backup: true },
      analytics: { enabled: 'false' }, backup: { id: 'ignored', repository: { id: 'other' }, includeSensitive: true }, custom: 'ignored' }) });
    value.faults.publish = 'denied'; saveState(value);
    ok(run(['setup'], 'y\nreconnect\n\nn\ny\nn\n'));
    const restored = config(); assert.equal(restored.update.cleanup, 'invalid'); assert.isFalse(restored.update.npm);
    assert.equal(restored.update.nvm, 'false'); assert.equal(restored.update.softwareupdate, 'true');
    assert.equal(restored.update.selfUpdate, 'false'); assert.equal(restored.update.backup, 'false');
    assert.equal(restored.analytics.enabled, 'false'); assert.deepEqual(restored.custom, { preserve: true });
    assert.equal(restored.backup.host, 'preserved.test'); assert.equal(restored.backup.includeSensitive, 'false');
    assert.isFalse(fs.existsSync(cacheRoot)); assert.equal(mutations().length, 0);
  });
  ['n\n', '', 'y', 'y\n', '\n'].forEach((automatic) => {
    it(`uses the existing automatic-backup choice after reconnect: ${JSON.stringify(automatic)}`, () => {
      unconfigured(); ok(run(['setup', 'ballin-backups'], `y\nreconnect\nn\ny\n${automatic}`));
      assert.equal(config().update.backup, ['y', 'y\n', '\n'].includes(automatic) ? 'true' : 'false');
    });
  });
  it('retains a configured destination when the subsequent automatic preference save fails', () => {
    unconfigured(); const value = config(); value.update.backup = {}; saveConfig(value);
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\n\n'); assert.equal(result.status, 1);
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.include(result.stdout, 'preference was not saved');
  });
  it('retains atomic destination persistence if a later automatic-backup write is interrupted', () => {
    unconfigured(); const preload = `const fs=require('fs'); const original=fs.writeFileSync; let saves=0;
      fs.writeFileSync=function(file,...args) { if(typeof file==='number' && ++saves===2) {
        original.call(this,file,'partial'); throw new Error('fixture interrupted preference write');
      } return original.call(this,file,...args); };`;
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\ny\n', {}, preload);
    assert.equal(result.status, 1); assert.include(result.stdout, 'preference was not saved');
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.equal(config().update.backup, 'false');
  });
  it('revalidates by stable identity after a rename and preserves local choices without prompting', () => {
    const value = state(); value.name = 'renamed'; saveState(value); seedCache('zshrc.sh', 'base\n');
    ok(run(['setup', 'renamed'])); assert.equal(config().backup.repository.name, 'renamed');
    assert.equal(config().backup.includeSensitive, 'true'); assert.equal(config().update.backup, 'false');
    assert.equal(cached(), 'base\n'); assert.equal(mutations().length, 0);
    assert.equal(run(['setup', 'wrong']).status, 1);
  });
  ['missing', 'denied'].forEach((fault) => {
    it(`never creates a replacement when reconnect lookup is ${fault}`, () => {
      unconfigured(); const value = state(); value.faults.candidate = fault; saveState(value);
      assert.equal(run(['setup'], 'y\nreconnect\n\nn\ny\n').status, 1); assert.equal(mutations().length, 0);
    });
  });
  it('rejects create collisions and malformed or conflicting destination configuration', () => {
    unconfigured(); assert.equal(run(['setup'], 'y\ncreate\n\n').status, 1); assert.equal(mutations().length, 0);
    for (const invalid of [[], {}, { ...fixtureDestination, id: '' }, { ...fixtureDestination, ownerId: 'bad id' }]) {
      const value = config(); value.backup.repository = invalid; saveConfig(value);
      assert.equal(run().status, 1); assert.equal(run(['setup']).status, 1);
    }
    const value = config(); value.backup.repository = fixtureDestination; value.backup.id = 'legacy'; saveConfig(value);
    assert.equal(run(['read', 'zshrc.sh']).status, 1); assert.equal(mutations().length, 0);
  });
  it('reports the existing initialized destination after a local save failure and permits explicit reconnect', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value); const before = config();
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n', { BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1' });
    assert.equal(result.status, 1); assert.deepEqual(config(), before); assert.include(result.stdout, 'Reconnect to the existing backup');
    ok(run(['setup'], 'y\nreconnect\n\nn\ny\nn\n')); assert.equal(mutations().length, 2);
  });
  it('identifies an ambiguous creation without retrying or linking an unconfirmed seed', () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.create = 'ambiguous'; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n'); assert.equal(result.status, 1);
    assert.include(result.stdout, 'https://github.com/fixture-user/ballin-backups'); assert.isNull(config().backup.repository);
    assert.equal(mutations().length, 1);
  });
  it('reports the known completed creation stage when initialization is rejected', () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.publish = 'denied'; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n'); assert.equal(result.status, 1);
    assert.include(result.stdout, 'Repository creation completed'); assert.include(result.stdout, 'initialization is unconfirmed');
    assert.isNull(config().backup.repository);
  });
  it('does not link recovered content when local cache invalidation fails', () => {
    unconfigured(); seedCache('zshrc.sh', 'stale\n');
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\n', {}, cacheFailure('rmSync', `args[0] === ${JSON.stringify(cacheRoot)}`));
    assert.equal(result.status, 1); assert.isNull(config().backup.repository); assert.equal(cached(), 'stale\n');
    assert.equal(mutations().length, 0);
  });
  it('disconnects locally and retries incomplete cleanup while writes stay disabled', () => {
    seedCache('zshrc.sh', 'base\n'); const before = config(); before.update.backup = 'true'; saveConfig(before);
    const result = run(['disconnect'], '', {}, cacheFailure('rmSync', `args[0] === ${JSON.stringify(cacheRoot)}`));
    assert.equal(result.status, 1); assert.include(result.stdout, 'cleanup is incomplete');
    assert.isNull(config().backup.repository); assert.isNull(config().backup.id); assert.equal(config().update.backup, 'false');
    assert.equal(config().backup.includeSensitive, 'true'); assert.equal(config().backup.host, before.backup.host);
    assert.equal(run().status, 1); ok(run(['disconnect'])); assert.isFalse(fs.existsSync(cacheRoot));
    assert.equal(state().requests.length, 0);
  });
  it('keeps the previous destination and cache when disconnect persistence fails', () => {
    seedCache('zshrc.sh', 'base\n'); const before = config();
    assert.equal(run(['disconnect'], '', { BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1' }).status, 1);
    assert.deepEqual(config(), before); assert.equal(cached(), 'base\n');
    assert.equal(run(['disconnect', 'extra']).status, 1); assert.equal(state().requests.length, 0);
  });
  it('invalidates file and symlink caches on disconnect without following the target', () => {
    fs.writeFileSync(cacheRoot, 'old cache'); ok(run(['disconnect']));
    const external = path.join(root, 'external'); fs.writeFileSync(external, 'keep'); fs.symlinkSync(external, cacheRoot);
    ok(run(['disconnect'])); assert.equal(fs.readFileSync(external, 'utf8'), 'keep'); assert.isFalse(fs.existsSync(cacheRoot));
  });
  it('rejects structurally malformed config before setup or disconnect mutations', () => {
    saveConfig({ update: [] }); assert.equal(run(['setup']).status, 1); assert.equal(run(['disconnect']).status, 1);
    assert.equal(state().requests.length, 0);
  });
  it('classifies configuration without inventing fallback destinations or additional consent values', () => {
    assert.equal(configuredBackupDestination({}).kind, 'unconfigured');
    assert.equal(configuredBackupDestination({ backup: { id: 'legacy', host: 'enterprise.test' } }).kind, 'legacy-gist');
    [null, [], { backup: [] }, { backup: { id: 4 } }, { backup: { repository: { ...fixtureDestination, branch: '' } } }].forEach((value) => {
      assert.equal(configuredBackupDestination(value).kind, 'invalid');
    });
    [undefined, false, 'false'].forEach((value) => assert.isFalse(sensitiveSourceConsent({ backup: { includeSensitive: value } })));
    [true, 'true'].forEach((value) => assert.isTrue(sensitiveSourceConsent({ backup: { includeSensitive: value } })));
    assert.isFalse(sensitiveSourceConsent({}));
  });
});
