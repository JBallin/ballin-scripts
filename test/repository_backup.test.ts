const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { fixtureDestination, fixtureRuleset, fixtureState, installRepositoryFixture, commitFixture, blobHash } = require('./helpers/repository.ts');
const { repositoryCacheDirectory } = require('../commands/backup_repository.ts');
const { configuredBackupDestination, sensitiveSourceConsent } = require('../commands/backup_config.ts');
const { createAnalyticsCapture, fixtureInstallId } = require('./helpers/analytics.ts');
import type { FixtureState } from './helpers/repository.ts';
import type { CapturedAnalyticsEvent } from './helpers/analytics.ts';

const repoRoot = path.join(__dirname, '..');
describe('repository backup lifecycle', function() {
  this.timeout(15000);
  let root: string; let home: string; let bin: string; let checkout: string;
  let configPath: string; let statePath: string; let cacheRoot: string; let cache: string;
  const state = (): FixtureState => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const saveState = (value: FixtureState): void => fs.writeFileSync(statePath, JSON.stringify(value));
  const config = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const saveConfig = (value: unknown): void => fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  const rulesetRequests = () => state().requests.filter((r) => r.endpoint.includes('/rulesets'));
  const rulesetWrites = () => rulesetRequests().filter((r) => r.method === 'POST');
  const mutations = () => state().requests.filter((r) => r.endpoint === 'user/repos'
    || r.payload?.query?.includes('BallinPublish') || (r.endpoint.includes('/rulesets') && r.method === 'POST'));
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
  const runSetup = (mode = 'self-update', env: NodeJS.ProcessEnv = {}, preload = '') => {
    const installedBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(installedBin, { recursive: true });
    fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'bin', 'ballin'), 'synthetic installed shim');
    const preloadPath = path.join(root, 'setup-preload.cjs');
    if (preload) fs.writeFileSync(preloadPath, preload);
    return spawnSync(process.execPath, [
      ...(preload ? ['--require', preloadPath] : []),
      path.join(repoRoot, 'commands', 'install_setup.ts'), 'setup', checkout,
      'https://example.test/docs', '', mode,
    ], {
      encoding: 'utf8', input: '', cwd: checkout, env: testChildEnvironment({
        HOME: home, PATH: `${bin}${path.delimiter}${installedBin}`, TMPDIR: path.join(root, 'tmp'),
        BALLIN_TEST_CONFIG_PATH: configPath, ...env,
      }),
    });
  };
  const ok = (result: { status: number; stdout: string; stderr: string }): void => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const assertSavedSensitiveChoice = (result: { stdout: string }, value: 'true' | 'false'): void => {
    const confirmation = `"backup.includeSensitive" set to: "${value}"`;
    const automaticPrompt = 'Automatically run `ballin backup` as part of `ballin update`?';
    assert.deepEqual(result.stdout.split('\n').filter((line: string) => line.startsWith('"backup.includeSensitive" set to:')), [confirmation]);
    assert.include(result.stdout, automaticPrompt);
    assert.isBelow(result.stdout.indexOf(confirmation), result.stdout.indexOf(automaticPrompt));
  };
  const cacheFailure = (method: string, condition: string): string => `
    const fs = require('fs'); const original = fs.${method};
    fs.${method} = function(...args) { if (${condition}) throw new Error('fixture failure'); return original.apply(this, args); };
  `;
  const transportCleanupFailure = (target: string): string => `
    const fs = require('fs'); const path = require('path'); const remove = fs.rmSync;
    let failed = false;
    fs.rmSync = function(entry, options) {
      if (!failed && path.basename(entry).startsWith('ballin-repository-')) {
        const requests = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')).requests;
        const request = requests.at(-1);
        const target = ${JSON.stringify(target)};
        const matches = target === 'all' || (target === 'ruleset-post'
          ? request?.endpoint.endsWith('/rulesets') && request?.method === 'POST' : false) || request?.endpoint === target
          || request?.endpoint.includes(target) || request?.payload?.query?.includes(target);
        if (matches) {
          failed = true;
          fs.appendFileSync(${JSON.stringify(path.join(root, 'cleanup.log'))}, entry + '\\n');
          throw new Error('DUMMY_PRIVATE_CLEANUP_ERROR');
        }
      }
      return remove(entry, options);
    };
  `;
  const assertTransportCleanupFailed = (result: { status: number; stdout: string; stderr: string }): void => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'Private temporary-file cleanup is incomplete');
    assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_CLEANUP_ERROR');
    assert.notInclude(result.stdout + result.stderr, 'dummy-secret-error');
    assert.notMatch(result.stdout, /[✔✚✎✖]/u);
    assert.notInclude(result.stdout, 'View changes:');
    const attempts = fs.readFileSync(path.join(root, 'cleanup.log'), 'utf8').trim().split('\n');
    assert.lengthOf(attempts, 1);
    assert.isTrue(fs.existsSync(attempts[0]));
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), [path.basename(attempts[0])]);
  };
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

  const priorSuccess = '2020-01-01T00:00:00.000Z\n';
  const statusFile = () => path.join(cache, '.last-success');
  const seedSuccess = () => {
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); fs.chmodSync(cacheRoot, 0o700); fs.chmodSync(cache, 0o700);
    fs.writeFileSync(statusFile(), priorSuccess, { mode: 0o600 });
  };
  const statusClock = (time: number) => `Date.now = () => ${time};`;

  it('aborts before collection or remote effects when Codex cwd restoration fails', () => {
    const codex = fs.realpathSync(home) + '/.codex';
    fs.mkdirSync(path.join(codex, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'skills', 'SKILL.md'), 'synthetic');
    seedCache('zshrc.sh', 'prior cache');
    const effects = path.join(root, 'unexpected-effects');
    const result = run([], '', {}, `
      const fs = require('fs'), path = require('path'), cp = require('child_process');
      const previous = process.cwd(), chdir = process.chdir, lstat = fs.lstatSync;
      process.chdir = (directory) => {
        if (directory === previous) throw new Error('synthetic restore failure');
        return chdir(directory);
      };
      fs.lstatSync = (file, ...args) => {
        if (path.resolve(file) === ${JSON.stringify(path.join(codex, 'rules'))}) fs.appendFileSync(${JSON.stringify(effects)}, 'continued discovery');
        return lstat(file, ...args);
      };
      cp.spawnSync = () => { fs.appendFileSync(${JSON.stringify(effects)}, 'child workflow'); throw new Error('No child workflows'); };
    `);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.isFalse(fs.existsSync(effects), 'fatal restoration must prevent later discovery and collection');
    assert.deepEqual(state().requests, []);
    assert.equal(cached('zshrc.sh'), 'prior cache');
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
  });

  ['skills', 'rules', 'agents', 'profiles', 'user_skills'].forEach((tree) => {
    it(`aborts ordinary backup without cache promotion when a selected Codex ${tree} leaf is unreadable`, () => {
      const codex = path.join(fs.realpathSync(home), '.codex');
      const leaf = tree === 'user_skills' ? path.join(fs.realpathSync(home), '.agents', 'skills', 'entry')
        : tree === 'profiles' ? path.join(codex, 'personal.config.toml') : path.join(codex, tree, 'entry');
      fs.mkdirSync(path.dirname(leaf), { recursive: true });
      fs.writeFileSync(leaf, 'synthetic');
      source('local shell\n');
      const snapshot = `codex_${tree}.bundle.json`;
      seedCache(snapshot, 'prior Codex cache\n');
      seedCache('zshrc.sh', 'prior shell cache\n');
      seedSuccess();
      const before = state();
      before.commits[before.head].files['zshrc.sh'] = Buffer.from('prior shell cache\n').toString('base64');
      saveState(before);
      const attempts = path.join(root, 'unreadable-attempts');
      const result = run([], '', { NODE_OPTIONS: `--require=${JSON.stringify(path.join(root, 'preload.cjs'))}` }, `
        const fs = require('fs'), path = require('path'), open = fs.openSync;
        fs.openSync = (file, ...args) => {
          if (typeof file === 'string' && path.resolve(file) === ${JSON.stringify(leaf)}) {
            fs.appendFileSync(${JSON.stringify(attempts)}, process.argv[1] + '\\n');
            const error = new Error('synthetic denied leaf'); error.code = 'EACCES'; throw error;
          }
          return open(file, ...args);
        };
      `);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, `failed to snapshot ${snapshot}`);
      assert.deepEqual(state().requests, [], 'capture must fail before remote reads or publication');
      assert.equal(cached(snapshot), 'prior Codex cache\n');
      assert.equal(cached('zshrc.sh'), 'prior shell cache\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess, 'failed Codex capture must not refresh success time');
      assert.deepEqual(fs.readdirSync(cache).sort(), [snapshot, 'zshrc.sh', '.last-success'].sort());
      assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
      assert.isTrue(fs.readFileSync(attempts, 'utf8').trim().split('\n').every((entry: string) => entry.endsWith('recursive_snapshot.ts')),
        'denied leaf opens belong to capture, not discovery');
    });
  });

  [
    { tree: 'skills', operation: 'opendirSync' },
    { tree: 'rules', operation: 'readSync' },
    { tree: 'agents', operation: 'lstatSync' },
    { tree: 'profiles', operation: 'opendirSync' },
    { tree: 'user_skills', operation: 'opendirSync' },
  ].forEach(({ tree, operation }) => {
    it(`aborts before staging when selected Codex ${tree} directory discovery fails at ${operation}`, () => {
      const codex = path.join(fs.realpathSync(home), '.codex');
      const directory = tree === 'user_skills' ? path.join(fs.realpathSync(home), '.agents', 'skills', 'nested')
        : tree === 'profiles' ? codex : path.join(codex, tree, 'nested');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, tree === 'profiles' ? 'personal.config.toml' : 'entry'), 'synthetic');
      source('local shell\n');
      const snapshot = `codex_${tree}.bundle.json`;
      seedCache(snapshot, 'prior Codex cache\n');
      seedCache('zshrc.sh', 'prior shell cache\n');
      seedSuccess();
      const before = state();
      before.commits[before.head].files['zshrc.sh'] = Buffer.from('prior shell cache\n').toString('base64');
      saveState(before);
      const result = run([], '', {}, `
        const fs = require('fs');
        const denied = () => { const error = new Error('synthetic directory denial'); error.code = 'EACCES'; throw error; };
        const original = fs[${JSON.stringify(operation)}];
        if (${JSON.stringify(operation)} === 'readSync') {
          const open = fs.opendirSync;
          fs.opendirSync = (...args) => {
            const dir = open(...args);
            if (process.cwd() === ${JSON.stringify(directory)}) dir.readSync = denied;
            return dir;
          };
        } else {
          fs[${JSON.stringify(operation)}] = (...args) => {
            if (process.cwd() === ${JSON.stringify(directory)}) denied();
            return original(...args);
          };
        }
      `);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, snapshot);
      assert.include(result.stderr, 'No snapshots were published');
      assert.deepEqual(state().requests, [], 'discovery failure must precede all remote reads');
      assert.equal(cached(snapshot), 'prior Codex cache\n');
      assert.equal(cached('zshrc.sh'), 'prior shell cache\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess, 'failed Codex capture must not refresh success time');
      assert.deepEqual(fs.readdirSync(cache).sort(), [snapshot, 'zshrc.sh', '.last-success'].sort());
      assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
    });
  });

  it('records changed and genuine no-op completion locally without another publication', () => {
    source(); seedSuccess();
    const firstTime = Date.parse('2026-01-01T00:00:00.000Z');
    const beforeCollection = `
      let output = ''; const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (...args) => { output += args[0]; return write(...args); };
      const snapshots = require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup_snapshots.ts'))});
      const observe = snapshots.observeSnapshotSources;
      snapshots.observeSnapshotSources = (...args) => {
        if (output !== 'Last successful backup: Dec 31, 2019, 4:00:00 PM GMT-08:00\\n') throw new Error('prior context missing before collection');
        return observe(...args);
      };
    `;
    const first = run([], '', { TZ: 'America/Los_Angeles' }, statusClock(firstTime) + beforeCollection); ok(first);
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), `${new Date(firstTime).toISOString()}\n`);
    assert.equal(first.stdout, `Last successful backup: Dec 31, 2019, 4:00:00 PM GMT-08:00\n✚ ballin_config\n✚ zshrc\nView changes: https://github.com/fixture-user/ballin-backups/commit/${state().head}\n`);
    assert.equal(cached(), 'local\n'); assert.equal(publications().length, 1);
    const head = state().head; const second = run([], '', { TZ: 'America/Los_Angeles' }, statusClock(firstTime + 1)); ok(second);
    assert.equal(second.stdout, 'Last successful backup: Dec 31, 2025, 4:00:00 PM GMT-08:00\n✔ ballin_config\n✔ zshrc\n');
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), `${new Date(firstTime + 1).toISOString()}\n`);
    assert.equal(state().head, head); assert.equal(publications().length, 1);
    assert.notProperty(state().commits[head].files, '.last-success');
  });
  for (const fault of ['reject', 'advance', 'orphan', 'wrong-readback']) {
    it(`preserves prior local success after ${fault} publication failure`, () => {
      source(); seedSuccess(); const value = state(); value.faults.publish = fault; saveState(value);
      const result = run([], '', { TZ: 'America/Los_Angeles' }); assert.equal(result.status, 1);
      assert.equal(result.stdout, 'Last successful backup: Dec 31, 2019, 4:00:00 PM GMT-08:00\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
      assert.notInclude(result.stdout, 'View changes:');
    });
  }
  for (const fault of ['ambiguous', 'malformed']) {
    it(`records success when ${fault} transport is resolved by coherent writer confirmation`, () => {
      source(); seedSuccess(); const value = state(); value.faults.publish = fault; saveState(value);
      ok(run()); assert.notEqual(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    });
  }
  it('preserves the record after collection failure and conflict', () => {
    source(); seedSuccess(); fs.unlinkSync(path.join(bin, 'cat'));
    fs.writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.equal(run().status, 1); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    fs.unlinkSync(path.join(bin, 'cat')); fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
    saveState(fixtureState({ 'zshrc.sh': 'conflicting\n' }));
    assert.equal(run().status, 1); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
  });
  for (const condition of ["String(args[1]).includes('.ballin-backup-cache-')", "String(args[0]).includes('ballin-backup-remote-')"]) {
    it(`preserves the record when required cache or temporary cleanup fails: ${condition}`, () => {
      source(); seedSuccess();
      if (condition.includes('remote-')) saveState(fixtureState({ 'zshrc.sh': 'local\n' }));
      const method = condition.includes('cache-') ? 'copyFileSync' : 'rmSync';
      assert.equal(run([], '', {}, cacheFailure(method, condition)).status, 1);
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    });
  }
  for (const method of ['writeFileSync', 'renameSync']) {
    it(`treats local timestamp ${method} failure as advisory after data success`, () => {
      source(); seedSuccess();
      const result = run([], '', {}, cacheFailure(method, "String(args[0]).includes('.last-success-')"));
      ok(result); assert.include(result.stderr, 'Backup succeeded, but Ballin could not record the local last-success time.');
      assert.equal(remote('zshrc.sh'), 'local\n'); assert.equal(cached(), 'local\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess); assert.equal(publications().length, 1);
      assert.include(result.stdout, `/commit/${state().head}\n`);
      assert.notInclude(result.stderr, 'fixture failure');
      const retry = run(); ok(retry); assert.notInclude(retry.stdout, 'View changes:');
      assert.notEqual(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    });
  }
  it('does not make unsafe advisory status a fatal snapshot-cache error', () => {
    source(); seedSuccess(); fs.unlinkSync(statusFile());
    const target = path.join(root, 'external-status'); fs.writeFileSync(target, priorSuccess); fs.symlinkSync(target, statusFile());
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(); ok(result); assert.notInclude(result.stdout, 'Last successful backup:');
      assert.notInclude(result.stdout, 'unavailable');
      assert.include(result.stderr, 'could not record'); assert.equal(fs.readFileSync(target, 'utf8'), priorSuccess);
      assert.isTrue(fs.lstatSync(statusFile()).isSymbolicLink());
    }
    assert.equal(publications().length, 1);
  });
  it('reports unavailable during validated setup without creating status; reads never advance it', () => {
    const before = config(); const setup = run(['setup']); ok(setup);
    assert.equal(setup.stdout, 'Validated private backup: https://github.com/fixture-user/ballin-backups\nSensitive sources: included\nAutomatic backup during update: disabled\nLast recorded successful backup on this installation: unavailable\n');
    assert.include(setup.stdout, 'on this installation: unavailable'); assert.isFalse(fs.existsSync(statusFile()));
    assert.deepEqual(config(), before);
    saveState(fixtureState({ 'zshrc.sh': 'local\n' })); seedSuccess();
    const recorded = fs.readFileSync(statusFile(), 'utf8');
    const validated = run(['setup']); ok(validated);
    assert.include(validated.stdout, `on this installation: ${recorded.trim()}`);
    ok(run(['read', 'zshrc.sh'])); ok(run(['open']));
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), recorded);
    ok(run(['disconnect'])); assert.isFalse(fs.existsSync(cacheRoot));
  });
  for (const representation of ['boolean', 'string']) {
    for (const sensitive of [false, true]) {
      for (const automatic of [false, true]) {
        it(`summarizes existing setup with ${representation} sensitive=${sensitive} automatic=${automatic} without changing state`, () => {
          const before = config();
          before.backup.includeSensitive = representation === 'string' ? String(sensitive) : sensitive;
          before.update.backup = representation === 'string' ? String(automatic) : automatic;
          saveConfig(before); seedCache('zshrc.sh', 'cached bytes\n'); seedSuccess(); source('different local bytes\n');
          const configBytes = fs.readFileSync(configPath, 'utf8'); const head = state().head;
          const noPromptsOrDiscovery = `
            const helpers = require(${JSON.stringify(path.join(repoRoot, 'commands', 'commandHelpers.ts'))});
            helpers.readPromptLine = () => { throw new Error('Unexpected setup prompt'); };
            const snapshots = require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup_snapshots.ts'))});
            snapshots.observeSnapshotSources = () => { throw new Error('Unexpected snapshot discovery'); };
            snapshots.snapshotDefinitions.forEach((definition) => {
              definition.discover = () => { throw new Error('Unexpected source review'); };
            });
          `;
          const result = run(['setup'], '', {}, noPromptsOrDiscovery); ok(result);
          assert.equal(result.stdout, `Validated private backup: https://github.com/fixture-user/ballin-backups\nSensitive sources: ${sensitive ? 'included' : 'excluded'}\nAutomatic backup during update: ${automatic ? 'enabled' : 'disabled'}\nLast recorded successful backup on this installation: ${priorSuccess}`);
          assert.equal(fs.readFileSync(configPath, 'utf8'), configBytes);
          assert.equal(cached(), 'cached bytes\n'); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
          assert.equal(state().head, head); assert.lengthOf(mutations(), 0);
          assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'GET']);
          const embedded = runSetup(); ok(embedded); assert.equal(embedded.stdout, '');
          assert.equal(fs.readFileSync(configPath, 'utf8'), configBytes);
          assert.equal(cached(), 'cached bytes\n'); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
          assert.equal(state().head, head); assert.lengthOf(mutations(), 0);
        });
      }
    }
  }
  for (const mode of ['refresh', 'self-update']) {
    it(`preserves validation and state during ${mode} setup with caller-specific output`, () => {
      seedCache('zshrc.sh', 'cached bytes\n'); seedSuccess(); source('different local bytes\n');
      const before = fs.readFileSync(configPath, 'utf8'); const head = state().head;
      const result = runSetup(mode); ok(result);
      assert.equal(result.stdout, mode === 'refresh'
        ? `Validated private backup: https://github.com/fixture-user/ballin-backups\nSensitive sources: included\nAutomatic backup during update: disabled\nLast recorded successful backup on this installation: ${priorSuccess}`
        : '');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.equal(cached(), 'cached bytes\n'); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
      assert.equal(state().head, head); assert.lengthOf(mutations(), 0);
      assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'GET']);
      assert.equal(fs.readlinkSync(path.join(home, '.local', 'bin', 'ballin')), path.join(checkout, 'bin', 'ballin'));
    });
  }
  it('keeps optional branch-protection warnings during self-update validation', () => {
    const value = state(); value.rulesets = []; value.faults.rulesetCreate = 'denied'; saveState(value);
    const before = config(); seedCache('zshrc.sh', 'cached bytes\n'); seedSuccess();
    const result = runSetup(); ok(result);
    assert.include(result.stdout, 'Optional GitHub branch protection was not enabled with the current permissions');
    assert.notInclude(result.stdout, 'Validated private backup:');
    assert.deepEqual(config(), before); assert.equal(cached(), 'cached bytes\n');
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess); assert.lengthOf(publications(), 0);
  });
  it('continues to skip unconfigured backup during self-update setup without prompts', () => {
    unconfigured(); const before = config();
    const result = runSetup(); ok(result); assert.equal(result.stdout, '');
    assert.deepEqual(config(), before); assert.lengthOf(state().requests, 0);
    assert.isFalse(fs.existsSync(cacheRoot));
  });
  it('defers unreadable snapshot bytes only during self-update while preserving local and remote state', () => {
    const value = fixtureState({ 'zshrc.sh': 'stored fixture bytes\n' });
    value.faults.unreadableBlob = blobHash(value.commits[value.head].files['zshrc.sh']);
    saveState(value); seedCache('zshrc.sh', 'cached fixture bytes\n'); seedSuccess(); source();
    const before = fs.readFileSync(configPath, 'utf8');
    ok(runSetup());
    assert.lengthOf(state().requests, 10);
    assert.lengthOf(state().requests.filter((request) => request.endpoint.includes('/git/blobs/')), 1);
    assert.equal(runSetup('refresh').status, 1);
    assert.equal(run(['setup']).status, 1);
    assert.equal(run().status, 1);
    const doctor = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'doctor'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: `${bin}${path.delimiter}${path.join(home, '.local', 'bin')}`,
        TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(doctor.status, 1); assert.include(doctor.stdout, 'could not be read completely');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.equal(cached(), 'cached fixture bytes\n'); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    assert.equal(state().head, value.head); assert.lengthOf(mutations(), 0);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
  });
  it('still persists a renamed destination and creates managed protection during self-update', () => {
    const value = state(); value.name = 'renamed'; value.rulesets = []; saveState(value);
    seedCache('zshrc.sh', 'unchanged\n'); seedSuccess();
    const result = runSetup(); ok(result);
    assert.equal(config().backup.repository.name, 'renamed');
    assert.include(result.stdout, 'GitHub branch protection enabled.');
    assert.lengthOf(rulesetWrites(), 1); assert.lengthOf(publications(), 0);
    assert.equal(state().head, value.head); assert.equal(cached(), 'unchanged\n');
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
  });
  it('summarizes absent sensitive consent as excluded without saving consent', () => {
    const before = config(); delete before.backup.includeSensitive; saveConfig(before);
    const result = run(['setup']); ok(result);
    assert.include(result.stdout, 'Sensitive sources: excluded\n'); assert.deepEqual(config(), before);
    assert.lengthOf(mutations(), 0);
  });
  it('summarizes the automatic-backup default supplied by existing setup configuration', () => {
    const before = config(); delete before.update.backup; saveConfig(before);
    const result = run(['setup']); ok(result);
    assert.include(result.stdout, 'Automatic backup during update: disabled\n');
    assert.deepEqual(config(), { ...before, update: { ...before.update, backup: 'false' } });
    assert.lengthOf(mutations(), 0);
  });
  for (const preference of ['sensitive', 'automatic']) {
    for (const invalid of [null, 'TRUE', {}]) {
      it(`summarizes invalid ${preference} preference ${JSON.stringify(invalid)} explicitly without repairing it`, () => {
        const before = config();
        const sensitive = preference === 'sensitive';
        if (sensitive) before.backup.includeSensitive = invalid;
        else before.update.backup = invalid;
        saveConfig(before); seedSuccess();
        const result = run(['setup']); ok(result);
        assert.include(result.stdout, sensitive
          ? 'Sensitive sources: invalid `backup.includeSensitive` (expected true or false)\n'
          : 'Automatic backup during update: invalid `update.backup` (expected true or false)\n');
        assert.deepEqual(config(), before); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
        assert.lengthOf(mutations(), 0);
        const embedded = runSetup(); ok(embedded);
        assert.equal(embedded.stdout, sensitive
          ? 'Sensitive sources: invalid `backup.includeSensitive` (expected true or false)\n'
          : 'Automatic backup during update: invalid `update.backup` (expected true or false)\n');
        assert.deepEqual(config(), before); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
        assert.lengthOf(mutations(), 0);
      });
    }
  }
  for (const failure of ['invalid configuration', 'unavailable repository', 'public repository', 'unreadable tree', 'unavailable account']) {
    it(`omits the settings summary when existing setup has ${failure}`, () => {
      const before = config(); const value = state();
      if (failure === 'invalid configuration') before.backup.repository = {};
      if (failure === 'unavailable repository') value.exists = false;
      if (failure === 'public repository') value.faults.node = { isPrivate: false };
      if (failure === 'unreadable tree') value.faults.tree = 'unreadable';
      if (failure === 'unavailable account') value.faults.auth = true;
      saveConfig(before); saveState(value); seedCache('zshrc.sh', 'unchanged\n'); seedSuccess();
      const result = run(['setup']); assert.equal(result.status, 1);
      assert.notInclude(result.stdout, 'Validated private backup:');
      assert.notInclude(result.stdout, 'Sensitive sources:');
      assert.notInclude(result.stdout, 'Automatic backup during update:');
      assert.notInclude(result.stdout, 'Last recorded successful backup');
      assert.deepEqual(config(), before); assert.equal(cached(), 'unchanged\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess); assert.lengthOf(mutations(), 0);
      const embedded = runSetup(); assert.equal(embedded.status, 1);
      assert.include(embedded.stdout, 'Unable to configure backup');
      assert.include(embedded.stdout, 'before retrying `ballin backup setup`');
      assert.notInclude(embedded.stdout, 'Validated private backup:');
      assert.include(embedded.stdout, result.stdout.trim());
      assert.deepEqual(config(), before); assert.equal(cached(), 'unchanged\n');
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess); assert.lengthOf(mutations(), 0);
    });
  }
  it('retains historical local success through same-identity rename and later remote change', () => {
    source(); ok(run()); const recorded = fs.readFileSync(statusFile(), 'utf8');
    const value = state(); value.name = 'renamed';
    commitFixture(value, { ...value.commits[value.head].files, 'zshrc.sh': Buffer.from('later remote bytes\n').toString('base64') });
    saveState(value);
    const setup = run(['setup']); ok(setup);
    assert.include(setup.stdout, `on this installation: ${recorded.trim()}`);
    assert.equal(fs.readFileSync(statusFile(), 'utf8'), recorded);
    assert.equal(config().backup.repository.name, 'renamed');
    assert.equal(publications().length, 1);
  });

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
      assert.equal(rulesetRequests().length, 0);
    });
  });
  ['synced', 'personal'].forEach((collision) => {
    it(`retains the complete saved Claude skills bundle and cache for a ${collision} name collision`, () => {
      const claude = path.join(home, '.claude');
      const first = path.join(claude, 'skills/synced/first/shared');
      const personal = path.join(claude, 'skills/personal');
      [first, personal].forEach(folder => fs.mkdirSync(folder, { recursive: true }));
      fs.writeFileSync(path.join(first, 'SKILL.md'), 'old synced skill');
      fs.writeFileSync(path.join(personal, 'SKILL.md'), 'old personal skill');
      fs.writeFileSync(path.join(first, '../manifest.json'), '{"skills":[{"name":"shared","source":"plugin"}]}');
      fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'old instructions\n');
      ok(run());
      const prior = remote('claude_skills.bundle.json');
      fs.writeFileSync(path.join(first, 'SKILL.md'), 'new synced skill');
      fs.writeFileSync(path.join(personal, 'SKILL.md'), 'new personal skill');
      const second = path.join(claude, 'skills', collision === 'synced' ? 'synced/second/shared' : 'shared');
      fs.mkdirSync(second, { recursive: true });
      fs.writeFileSync(path.join(second, 'SKILL.md'), 'DUMMY_COLLIDING_SKILL');
      if (collision === 'synced') fs.writeFileSync(path.join(second, '../manifest.json'), '{"skills":[{"name":"shared","source":"plugin"}]}');
      fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'new instructions\n');
      const result = run(); ok(result);
      assert.equal(remote('claude_skills.bundle.json'), prior);
      assert.equal(cached('claude_skills.bundle.json'), prior);
      assert.equal(remote('claude_instructions'), 'new instructions\n');
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_COLLIDING_SKILL');
      const saved = run(['read', 'claude_skills.bundle.json', '--file', 'shared/SKILL.md']); ok(saved);
      assert.equal(saved.stdout, 'old synced skill');
      assert.lengthOf(publications(), 2);
    });
  });

  [false, true].forEach((trustedCache) => {
    it(`reconciles old namespaced Claude v2 paths with the ordinary cache rules: ${trustedCache}`, () => {
      const folder = path.join(home, '.claude/skills/synced/collection/package');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'SKILL.md'), 'same skill\n');
      fs.writeFileSync(path.join(folder, '../manifest.json'), '{"skills":[{"name":"package","source":"plugin"}]}');
      const oldPath = 'synced/collection/package/SKILL.md';
      const previous = `${JSON.stringify({ format: 'ballin-directory', version: 2, entries: [
        { path: oldPath, executable: false, encoding: 'utf8', content: ['same skill\n'] },
      ] }, null, 2)}\n`;
      saveState(fixtureState({ 'claude_skills.bundle.json': previous }));
      if (trustedCache) seedCache('claude_skills.bundle.json', previous);
      const saved = run(['read', 'claude_skills.bundle.json', '--file', oldPath]); ok(saved);
      assert.equal(saved.stdout, 'same skill\n');
      const result = run();
      if (!trustedCache) {
        assert.equal(result.status, 1); assert.include(result.stderr, 'conflict for claude_skills.bundle.json');
        assert.equal(remote('claude_skills.bundle.json'), previous);
        assert.isUndefined(cached('claude_skills.bundle.json'));
        assert.lengthOf(publications(), 0);
        return;
      }
      ok(result);
      assert.deepEqual(JSON.parse(remote('claude_skills.bundle.json')!).entries.map((entry: { path: string }) => entry.path), ['package/SKILL.md']);
      assert.equal(cached('claude_skills.bundle.json'), remote('claude_skills.bundle.json'));
      const direct = run(['read', 'claude_skills.bundle.json', '--file', 'package/SKILL.md']); ok(direct);
      assert.equal(direct.stdout, 'same skill\n');
      const head = state().head; ok(run());
      assert.equal(state().head, head);
      assert.lengthOf(publications(), 1);
    });
  });

  it('retains the complete saved skills bundle when sync metadata is unavailable while other Claude sources advance', () => {
    const claude = path.join(home, '.claude');
    const collection = path.join(claude, 'skills', 'synced', 'collection');
    fs.mkdirSync(path.join(collection, 'custom'), { recursive: true });
    fs.mkdirSync(path.join(claude, 'skills', 'personal'));
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'old instructions\n');
    fs.writeFileSync(path.join(claude, 'skills', 'personal', 'SKILL.md'), 'old personal skill');
    fs.writeFileSync(path.join(collection, 'custom', 'SKILL.md'), 'synced plugin skill');
    const manifest = path.join(collection, 'manifest.json');
    fs.writeFileSync(manifest, '{"skills":[{"name":"custom","source":"plugin"}]}');
    ok(run());
    const prior = remote('claude_skills.bundle.json');
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'new instructions\n');
    fs.writeFileSync(path.join(claude, 'skills', 'personal', 'SKILL.md'), 'new personal skill');
    fs.writeFileSync(manifest, '{DUMMY_INVALID_METADATA');
    const malformed = run(); ok(malformed);
    assert.equal(remote('claude_skills.bundle.json'), prior);
    assert.equal(cached('claude_skills.bundle.json'), prior);
    assert.equal(remote('claude_instructions'), 'new instructions\n');
    assert.notInclude(malformed.stdout + malformed.stderr, 'DUMMY_INVALID_METADATA');
    fs.writeFileSync(manifest, '{"skills":[{"name":"custom","source":"anthropic","source":"plugin"}]}');
    ok(run());
    assert.equal(remote('claude_skills.bundle.json'), prior);
    assert.equal(cached('claude_skills.bundle.json'), prior);
    fs.writeFileSync(manifest, '{"skills":[],"skills":[{"name":"custom","source":"plugin"}]}');
    ok(run());
    assert.equal(remote('claude_skills.bundle.json'), prior);
    assert.equal(cached('claude_skills.bundle.json'), prior);
    fs.rmSync(manifest); ok(run());
    assert.equal(remote('claude_skills.bundle.json'), prior);
    assert.lengthOf(publications(), 2);
  });
  [false, true].forEach((included) => {
    it(`publishes synthetic Codex sources with the existing sensitive preference: ${included}`, () => {
      const value = config();
      value.backup.includeSensitive = String(included);
      saveConfig(value);
      const codex = path.join(home, 'active-codex');
      fs.mkdirSync(path.join(codex, 'skills', 'synthetic'), { recursive: true });
      const wholeConfig = '[projects."/synthetic"]\ntrust_level = "trusted"\n';
      fs.writeFileSync(path.join(codex, 'config.toml'), wholeConfig);
      fs.writeFileSync(path.join(codex, 'skills', 'synthetic', 'SKILL.md'), 'synthetic skill\n');
      ok(run([], '', { CODEX_HOME: codex }));
      if (included) {
        assert.equal(remote('codex_config.toml'), wholeConfig);
        const archive = JSON.parse(remote('codex_skills.bundle.json')!);
        assert.equal(archive.format, 'ballin-directory');
        assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['synthetic/SKILL.md']);
        assert.equal(archive.version, 2);
        assert.deepEqual(archive.entries[0].content, ['synthetic skill\n']);
        assert.equal(cached('codex_config.toml'), wholeConfig);
        assert.equal(cached('codex_skills.bundle.json'), remote('codex_skills.bundle.json'));
      } else {
        assert.isUndefined(remote('codex_config.toml'));
        assert.isUndefined(remote('codex_skills.bundle.json'));
      }
      assert.notProperty(JSON.parse(remote('ballin_config')!), 'backup');
      ok(run([], '', { CODEX_HOME: codex }));
      assert.lengthOf(publications(), 1);
    });
  });
  for (const snapshot of ['codex_skills.bundle.json', 'codex_user_skills.bundle.json']) {
    it(`retains saved ${snapshot} when only omitted skill metadata remains locally`, () => {
      const skillRoot = snapshot === 'codex_skills.bundle.json' ? path.join(home, '.codex/skills') : path.join(home, '.agents/skills');
      const metadata = path.join(skillRoot, 'demo/agents/openai.yaml');
      fs.mkdirSync(path.dirname(metadata), { recursive: true });
      fs.writeFileSync(metadata, 'synthetic: source remains intact\n');
      const archived = JSON.stringify({ format: 'ballin-directory', version: 2, entries: [
        { path: 'demo/SKILL.md', executable: false, encoding: 'utf8', content: ['saved instructions\n'] },
        { path: 'demo/agents/openai.yaml', executable: false, encoding: 'utf8', content: ['saved metadata\n'] },
      ] });
      saveState(fixtureState({ [snapshot]: archived }));
      seedCache(snapshot, archived);
      source();
      ok(run());
      assert.equal(remote(snapshot), archived);
      assert.equal(cached(snapshot), archived);
      assert.equal(fs.readFileSync(metadata, 'utf8'), 'synthetic: source remains intact\n');
      assert.equal(remote('zshrc.sh'), 'local\n');
      assert.lengthOf(publications(), 1);
    });
  }
  describe('bundle reset and conflicts', () => {
    const bytes = Buffer.from('\ufeffsynthetic\r\nlast');
    const legacyEntry = { path: 'nested/fixture.md', executable: false, content: bytes.toString('base64') };
    const legacy = (entry = legacyEntry, extra = {}): string => `${JSON.stringify({
      format: 'ballin-directory', version: 1, entries: [entry], ...extra,
    }, null, 2)}\n`;
    const localDirectory = (): void => {
      fs.mkdirSync(path.join(home, '.codex', 'rules', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'rules', 'nested', 'fixture.md'), bytes, { mode: 0o600 });
    };
    it('retains retired directory files without blocking normal bundle publication', () => {
      const oldNames = ['codex_profiles.json', 'codex_skills.json', 'codex_user_skills.json', 'codex_rules.json', 'codex_agents.json', 'claude_rules', 'claude_agents', 'claude_commands'];
      localDirectory(); saveState(fixtureState(Object.fromEntries(oldNames.map((name) => [name, legacy()]))));
      seedCache('codex_rules.json', 'untrusted old cache');
      ok(run());
      for (const name of oldNames) assert.equal(remote(name), legacy());
      assert.equal(JSON.parse(remote('codex_rules.bundle.json')!).version, 2);
      assert.equal(cached('codex_rules.json'), 'untrusted old cache');
      assert.equal(cached('codex_rules.bundle.json'), remote('codex_rules.bundle.json'));
      assert.lengthOf(publications(), 1);
    });
    it('creates a fresh bundle after reset without trusting an old-name cache', () => {
      localDirectory(); seedCache('codex_rules.json', 'untrusted old cache');
      ok(run());
      assert.equal(JSON.parse(remote('codex_rules.bundle.json')!).version, 2);
      assert.equal(cached('codex_rules.json'), 'untrusted old cache');
      assert.equal(cached('codex_rules.bundle.json'), remote('codex_rules.bundle.json'));
      const head = state().head; ok(run()); assert.equal(state().head, head);
    });
    for (const contents of [
      legacy({ ...legacyEntry, executable: true }), legacy({ ...legacyEntry, path: 'changed.md' }),
      legacy({ ...legacyEntry, content: Buffer.from('different').toString('base64') }), legacy(legacyEntry, { unknown: 'DUMMY_PRIVATE_EXTRA' }),
      legacy(legacyEntry, { version: 3 }), JSON.stringify(JSON.parse(legacy())),
    ]) {
      it('keeps no-base conflicts for changed metadata, payload, unknown fields or noncanonical serialization', () => {
        localDirectory(); saveState(fixtureState({ 'codex_rules.bundle.json': contents }));
        const head = state().head; const result = run();
        assert.equal(result.status, 1, result.stdout + result.stderr); assert.include(result.stderr, 'conflict for codex_rules.bundle.json');
        assert.equal(state().head, head); assert.lengthOf(publications(), 0); assert.isUndefined(cached('codex_rules.bundle.json'));
        assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE');
      });
    }
    it('retains raw v2 comparison for different serialization even with identical decoded files', () => {
      localDirectory(); ok(run());
      const value = state(); const changed = JSON.stringify(JSON.parse(remote('codex_rules.bundle.json')!));
      commitFixture(value, { ...value.commits[value.head].files, 'codex_rules.bundle.json': Buffer.from(changed).toString('base64') });
      saveState(value); const result = run();
      assert.equal(result.status, 1); assert.include(result.stderr, 'conflict for codex_rules.bundle.json');
      assert.lengthOf(publications(), 1); assert.equal(remote('codex_rules.bundle.json'), changed);
    });
    it('rejects dense newline overflow before remote inspection or cache effects', () => {
      localDirectory(); fs.writeFileSync(path.join(home, '.codex', 'rules', 'nested', 'fixture.md'), Buffer.alloc(2 * 1024 * 1024, 10));
      const result = run(); assert.equal(result.status, 1); assert.include(result.stderr, 'Snapshot bytes limit exceeded');
      assert.lengthOf(state().requests, 0); assert.isFalse(fs.existsSync(cache));
    });
  });
  [false, true].forEach((included) => {
    it(`captures selected Claude Markdown and complete skills with existing sensitive consent: ${included}`, () => {
      const value = config(); value.backup.includeSensitive = String(included); saveConfig(value);
      const claude = path.join(home, 'active-claude');
      fs.mkdirSync(path.join(claude, 'rules', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '@../outside.md\nDUMMY_SELECTED_SECRET\n');
      fs.writeFileSync(path.join(claude, 'rules', 'nested', 'fixture.md'), 'synthetic rule\n');
      fs.writeFileSync(path.join(claude, 'rules', 'ignored.json'), 'DUMMY_EXCLUDED_SECRET');
      fs.writeFileSync(path.join(claude, 'settings.json'), 'DUMMY_SETTINGS_SECRET');
      fs.mkdirSync(path.join(claude, 'skills', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(claude, 'skills', 'SKILL.md'), 'DUMMY_SKILL_SECRET');
      fs.writeFileSync(path.join(claude, 'skills', 'demo', 'SKILL.md'), 'personal skill');
      fs.writeFileSync(path.join(claude, 'skills', 'demo', '.support'), 'DUMMY_SELECTED_SKILL_SECRET');
      fs.writeFileSync(path.join(claude, 'skills', 'demo', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
      const collection = '1ee7e3ab-14cd-4d49-9fce-a2f5fa33d125_e29e4a19-d6c5-4efd-a06e-1dbd9ea691a8';
      const synced = path.join(claude, 'skills', 'synced', collection);
      fs.mkdirSync(path.join(synced, 'pdf'), { recursive: true });
      fs.writeFileSync(path.join(synced, 'pdf', 'SKILL.md'), 'plugin package with a default-looking name');
      fs.writeFileSync(path.join(synced, 'pdf', '.support'), 'DUMMY_SELECTED_SYNCED_SECRET');
      fs.writeFileSync(path.join(synced, 'manifest.json'), '{"skills":[{"name":"pdf","source":"plugin"},{"name":"default","source":"anthropic"}],"private":"DUMMY_EXCLUDED_SECRET"}');
      fs.mkdirSync(path.join(synced, 'default'));
      fs.writeFileSync(path.join(synced, 'default', 'SKILL.md'), 'DUMMY_EXCLUDED_SECRET');
      fs.mkdirSync(path.join(synced, '.staging', 'partial'), { recursive: true });
      fs.writeFileSync(path.join(synced, '.staging', 'partial', 'SKILL.md'), 'DUMMY_EXCLUDED_SECRET');
      const skillPaths = ['demo/.support', 'demo/SKILL.md', 'demo/run.sh', 'pdf/.support', 'pdf/SKILL.md'];
      ok(run([], '', { CLAUDE_CONFIG_DIR: claude }));
      if (included) {
        assert.equal(remote('claude_instructions'), '@../outside.md\nDUMMY_SELECTED_SECRET\n');
        const archive = JSON.parse(remote('claude_rules.bundle.json')!);
        assert.deepEqual(archive.entries.map((entry: { path: string }) => entry.path), ['nested/fixture.md']);
        assert.equal(cached('claude_rules.bundle.json'), remote('claude_rules.bundle.json'));
        const skills = JSON.parse(remote('claude_skills.bundle.json')!);
        assert.deepEqual(skills.entries.map((entry: { path: string }) => entry.path), skillPaths);
        assert.notInclude(remote('claude_skills.bundle.json'), 'DUMMY_EXCLUDED_SECRET');
        assert.equal(cached('claude_skills.bundle.json'), remote('claude_skills.bundle.json'));
        const listed = run(['read', 'claude_skills.bundle.json', '--list']); ok(listed);
        assert.deepEqual(JSON.parse(listed.stdout).map((entry: { path: string }) => entry.path), skillPaths);
        const member = run(['read', 'claude_skills.bundle.json', '--file', 'demo/.support']); ok(member);
        assert.equal(member.stdout, 'DUMMY_SELECTED_SKILL_SECRET');
        const syncedMember = run(['read', 'claude_skills.bundle.json', '--file', 'pdf/.support']); ok(syncedMember);
        assert.equal(syncedMember.stdout, 'DUMMY_SELECTED_SYNCED_SECRET');
      } else {
        assert.isUndefined(remote('claude_instructions'));
        assert.isUndefined(remote('claude_rules.bundle.json'));
        assert.isUndefined(remote('claude_skills.bundle.json'));
      }
      const files = state().commits[state().head].files;
      assert.notProperty(files, 'claude_settings.json');
      assert.notProperty(files, 'claude_skills');
      const repeated = run([], '', { CLAUDE_CONFIG_DIR: claude }); ok(repeated);
      assert.notInclude(repeated.stdout, 'View changes:');
      assert.lengthOf(publications(), 1);
    });
  });
  it('reviews selected Claude paths and Markdown readability without collecting contents', () => {
    unconfigured();
    const claude = path.join(fs.realpathSync(home), '.claude');
    fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'DUMMY_INSTRUCTIONS_SECRET');
    fs.writeFileSync(path.join(claude, 'agents', 'review.md'), 'DUMMY_AGENT_SECRET');
    fs.writeFileSync(path.join(claude, 'agents', 'ignored.json'), 'DUMMY_EXCLUDED_SECRET');
    fs.mkdirSync(path.join(claude, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'skills', 'demo', 'SKILL.md'), 'DUMMY_SKILL_SECRET');
    fs.writeFileSync(path.join(claude, 'skills', 'demo', '.support'), 'DUMMY_SUPPORT_SECRET');
    const result = run(['setup'], 'y\nreconnect\n\ny\nn\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Sensitive sources may contain credentials or other private information.');
    assert.include(result.stdout, `claude_agents.bundle.json: ${JSON.stringify(path.join(home, '.claude', 'agents'))}`);
    assert.include(result.stdout, `claude_skills.bundle.json: ${JSON.stringify(path.join(home, '.claude', 'skills'))}`);
    assert.include(result.stdout, 'Your choice also covers future supported sources.');
    assert.include(result.stdout, 'Synced Claude skills include plugin-origin packages only; defaults and other origins are excluded.');
    assert.notInclude(result.stdout + result.stderr, 'DUMMY_');
    assert.lengthOf(mutations(), 0);
  });
  it('fails selected Claude discovery before remote inspection and skips it with consent off', () => {
    const claude = path.join(fs.realpathSync(home), '.claude');
    fs.mkdirSync(path.join(claude, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'rules', 'fixture.md'), 'synthetic');
    const preload = `const fs=require('fs'); const opendir=fs.opendirSync;
      fs.opendirSync=function(file,...args) {
        if(file==='.' && process.cwd()===${JSON.stringify(path.join(claude, 'rules'))}) throw new Error('DUMMY_DISCOVERY_SECRET');
        return opendir.call(this,file,...args);
      };`;
    const failed = run([], '', {}, preload);
    assert.equal(failed.status, 1);
    assert.include(failed.stderr, 'selected Claude Code source could not be discovered completely');
    assert.notInclude(failed.stderr, 'DUMMY_DISCOVERY_SECRET');
    assert.lengthOf(state().requests, 0);
    assert.isFalse(fs.existsSync(cache));
    const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
    ok(run([], '', {}, preload));
    assert.isUndefined(remote('claude_rules.bundle.json'));
  });
  it('aborts unreadable Claude skill support without remote reads and skips discovery with consent off', () => {
    const skill = path.join(fs.realpathSync(home), '.claude', 'skills', 'demo');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'synthetic skill');
    fs.writeFileSync(path.join(skill, '.support'), 'DUMMY_SUPPORT_SECRET');
    const preload = `const fs=require('fs'); const open=fs.openSync;
      fs.openSync=function(file,...args) {
        if(file==='.support' && process.cwd()===${JSON.stringify(skill)}) throw new Error('DUMMY_CAPTURE_SECRET');
        return open.call(this,file,...args);
      };`;
    const env = { NODE_OPTIONS: `--require=${JSON.stringify(path.join(root, 'preload.cjs'))}` };
    const failed = run([], '', env, preload);
    assert.equal(failed.status, 1);
    assert.notInclude(failed.stderr, 'DUMMY_');
    assert.lengthOf(state().requests, 0); assert.isFalse(fs.existsSync(cache));
    const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
    ok(run([], '', env, preload));
    assert.isUndefined(remote('claude_skills.bundle.json'));
  });
  it('retains a saved Claude skill bundle when a legacy manifest makes the source unavailable', () => {
    const archived = JSON.stringify({ format: 'ballin-directory', version: 2, entries: [{ path: 'saved/SKILL.md', executable: false, encoding: 'utf8', content: ['saved'] }] }) + '\n';
    saveState(fixtureState({ 'claude_skills.bundle.json': archived }));
    const skills = path.join(home, '.claude', 'skills'); fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'manifest.json'), 'DUMMY_LEGACY_SECRET');
    ok(run());
    assert.equal(remote('claude_skills.bundle.json'), archived);
  });
  describe('local Claude snapshot budgets', function() {
    this.timeout(30000);
    const mib = 1024 * 1024;
    const sparse = (file: string, size: number): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'w');
      try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
    };
    it('rejects combined raw and archived Claude captures before remote reads', () => {
      sparse(path.join(home, '.claude', 'CLAUDE.md'), 9 * mib);
      sparse(path.join(home, '.claude', 'agents', 'fixture.md'), 6 * mib);
      const result = run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.lengthOf(state().requests, 0);
      assert.isFalse(fs.existsSync(cache));
    });
    it('counts the complete skills bundle toward the existing combined Claude allowance', () => {
      sparse(path.join(home, '.claude', 'CLAUDE.md'), 9 * mib);
      sparse(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), 6 * mib);
      const result = run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.lengthOf(state().requests, 0); assert.isFalse(fs.existsSync(cache));
    });
    it('counts synced package serialization toward the shared Claude allowance before remote reads', () => {
      sparse(path.join(home, '.claude', 'CLAUDE.md'), 9 * mib);
      sparse(path.join(home, '.claude', 'skills', 'synced', 'collection', 'pdf', 'SKILL.md'), 6 * mib);
      fs.writeFileSync(path.join(home, '.claude', 'skills', 'synced', 'collection', 'manifest.json'), '{"skills":[{"name":"pdf","source":"plugin"}]}');
      const result = run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.lengthOf(state().requests, 0); assert.isFalse(fs.existsSync(cache));
    });
    it('preserves the Codex allowance alongside an independent Claude allowance', () => {
      const codexContent = 'c'.repeat(9 * mib - 1) + '\n';
      const claudeContent = 'a'.repeat(9 * mib - 1) + '\n';
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), codexContent);
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), claudeContent);
      ok(run());
      assert.equal(remote('codex_config.toml'), codexContent);
      assert.equal(remote('claude_instructions'), claudeContent);
      assert.lengthOf(publications(), 1);
    });
    it('bounds selected Claude cache comparisons but ignores unused oversized cache entries', () => {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'synthetic local\n');
      saveState(fixtureState({ claude_instructions: 'synthetic remote\n' }));
      sparse(path.join(cache, 'claude_instructions'), 16 * mib + 1);
      const failed = run();
      assert.equal(failed.status, 1);
      assert.lengthOf(mutations(), 0);
      assert.isFalse(fs.existsSync(path.join(cache, 'ballin_config')));
      const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
      ok(run());
      assert.equal(fs.statSync(path.join(cache, 'claude_instructions')).size, 16 * mib + 1);
      assert.equal(remote('claude_instructions'), 'synthetic remote\n');
    });
  });
  describe('local Codex snapshot budgets', function() {
    this.timeout(30000);
    const mib = 1024 * 1024;
    const sparse = (file: string, size: number): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'w');
      try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
    };
    const active = (): string => path.join(home, 'budget-codex');

    it('rejects combined raw and recursive staging above 16 MiB before remote reads', () => {
      const codex = active();
      sparse(path.join(codex, 'config.toml'), 9 * mib);
      sparse(path.join(codex, 'skills', 'synthetic', 'SKILL.md'), 6 * mib);
      const before = state().head;
      const result = run([], '', { CODEX_HOME: codex });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(state().head, before);
      assert.lengthOf(state().requests, 0);
      assert.isFalse(fs.existsSync(cache));
    });

    it('shares the aggregate capture budget across legacy and current personal skills', () => {
      sparse(path.join(active(), 'skills', 'legacy', 'SKILL.md'), 7 * mib);
      sparse(path.join(home, '.agents', 'skills', 'current', 'SKILL.md'), 7 * mib);
      const before = state().head;
      const result = run([], '', { CODEX_HOME: active() });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(state().head, before);
      assert.lengthOf(state().requests, 0);
      assert.isFalse(fs.existsSync(cache));
    });

    it('counts both skill archive identities when CODEX_HOME overlaps the fixed user root', () => {
      const shared = path.join(home, '.agents');
      sparse(path.join(shared, 'skills', 'demo', 'SKILL.md'), 7 * mib);
      const result = run([], '', { CODEX_HOME: shared });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.lengthOf(state().requests, 0);
      assert.isFalse(fs.existsSync(cache));
    });

    it('rejects excessive recursive entries before any remote read', () => {
      const skills = path.join(active(), 'skills');
      fs.mkdirSync(skills, { recursive: true });
      for (let index = 0; index < 8193; index += 1) fs.writeFileSync(path.join(skills, `synthetic-${index}`), '');
      const result = run([], '', { CODEX_HOME: active() });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'recursive source exceeds the supported snapshot limits');
      assert.lengthOf(state().requests, 0);
      assert.isFalse(fs.existsSync(cache));
    });

    it('rejects an oversized compared Codex cache without publication or promotion', () => {
      const codex = active();
      fs.mkdirSync(codex);
      fs.writeFileSync(path.join(codex, 'config.toml'), 'synthetic local\n');
      saveState(fixtureState({ 'codex_config.toml': 'synthetic remote\n' }));
      sparse(path.join(cache, 'codex_config.toml'), 16 * mib + 1);
      const before = state().head;
      const result = run([], '', { CODEX_HOME: codex });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(state().head, before);
      assert.lengthOf(mutations(), 0);
      assert.equal(fs.statSync(path.join(cache, 'codex_config.toml')).size, 16 * mib + 1);
      assert.isFalse(fs.existsSync(path.join(cache, 'ballin_config')));
    });

    [false, true].forEach((included) => {
      it(`ignores oversized unselected or absent Codex cache: sensitive ${included}`, () => {
        const value = config(); value.backup.includeSensitive = String(included); saveConfig(value);
        sparse(path.join(cache, 'codex_config.toml'), 16 * mib + 1);
        ok(run([], '', { CODEX_HOME: active() }));
        assert.equal(fs.statSync(path.join(cache, 'codex_config.toml')).size, 16 * mib + 1);
        assert.isUndefined(remote('codex_config.toml'));
      });
    });

    it('publishes encoded content above 16 MiB when normalized local bytes fit', () => {
      const codex = active(); fs.mkdirSync(codex);
      const content = 'x'.repeat(13 * mib - 1) + '\n';
      fs.writeFileSync(path.join(codex, 'config.toml'), content);
      ok(run([], '', { CODEX_HOME: codex }));
      const input = publications()[0].payload?.variables?.input as { fileChanges: { additions: { path: string; contents: string }[] } };
      const addition = input.fileChanges.additions.find((entry) => entry.path === 'codex_config.toml');
      assert.exists(addition);
      assert.isAbove(addition!.contents.length, 16 * mib);
      assert.equal(remote('codex_config.toml'), content);
      assert.equal(cached('codex_config.toml'), content);
    });

    it('retains old absent Codex data without imposing a remote aggregate quota', () => {
      const retained = 'r'.repeat(12 * mib - 1) + '\n';
      const content = 'n'.repeat(12 * mib - 1) + '\n';
      saveState(fixtureState({ 'codex_AGENTS.md': retained }));
      const codex = active(); fs.mkdirSync(codex);
      fs.writeFileSync(path.join(codex, 'config.toml'), content);
      ok(run([], '', { CODEX_HOME: codex }));
      assert.equal(remote('codex_AGENTS.md'), retained);
      assert.equal(remote('codex_config.toml'), content);
      const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
      ok(run([], '', { CODEX_HOME: codex }));
      assert.equal(remote('codex_AGENTS.md'), retained);
      assert.equal(remote('codex_config.toml'), content);
      assert.lengthOf(publications(), 1);
    });
  });
  it('sorts final snapshot status output without changing publication order', () => {
    source();

    const result = run();

    ok(result);
    assert.equal(result.stdout, `✚ ballin_config\n✚ zshrc\nView changes: https://github.com/fixture-user/ballin-backups/commit/${state().head}\n`);
    const input = publications()[0].payload?.variables?.input as { fileChanges: { additions: { path: string }[] } };
    assert.deepEqual(input.fileChanges.additions.map(({ path: filePath }) => filePath), ['zshrc.sh', 'ballin_config']);
  });
  it('links the confirmed publication using the current owner and repository name, then omits no-op links', () => {
    source(); const value = state(); value.login = 'renamed-user'; value.name = 'renamed-backups'; saveState(value);
    const result = run(); ok(result);
    assert.include(result.stdout, `View changes: https://github.com/renamed-user/renamed-backups/commit/${state().head}\n`);
    assert.isFalse(state().requests.some((request) => request.endpoint === 'open'));
    const unchanged = run(); ok(unchanged);
    assert.notInclude(unchanged.stdout, 'View changes:'); assert.lengthOf(publications(), 1);
  });
  it('keeps the link pinned when the remote head advances after publication confirmation', () => {
    source();
    const evidence = path.join(root, 'confirmed-head');
    const preload = `
      const fs = require('fs'); const rename = fs.renameSync;
      fs.renameSync = function(...args) {
        const result = rename.apply(this, args);
        if (String(args[0]).includes('.ballin-backup-cache-') && !fs.existsSync(${JSON.stringify(evidence)})) {
          const file = ${JSON.stringify(statePath)}; const state = JSON.parse(fs.readFileSync(file, 'utf8'));
          fs.writeFileSync(${JSON.stringify(evidence)}, state.head);
          state.head = 'a'.repeat(40); fs.writeFileSync(file, JSON.stringify(state));
        }
        return result;
      };
    `;
    const result = run([], '', {}, preload); ok(result);
    const confirmed = fs.readFileSync(evidence, 'utf8');
    assert.include(result.stdout, `/commit/${confirmed}\n`);
    assert.notInclude(result.stdout, `/commit/${state().head}`);
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
      assert.include(run().stderr, 'invalid `backup.includeSensitive`'); assert.equal(state().requests.length, 0);
    });
  });
  ['ambiguous', 'malformed'].forEach((mode) => {
    it(`confirms ${mode} publication and never duplicates it on the next run`, () => {
      source(); const value = state(); value.faults.publish = mode; saveState(value);
      const result = run(); ok(result);
      assert.include(result.stdout, `/commit/${state().head}\n`);
      const unchanged = run(); ok(unchanged); assert.notInclude(unchanged.stdout, 'View changes:');
      assert.equal(publications().length, 1); assert.equal(cached(), 'local\n');
    });
  });
  ['advance', 'denied', 'orphan', 'wrong-readback'].forEach((mode) => {
    it(`leaves comparison bytes intact after ${mode}`, () => {
      source(); seedCache('zshrc.sh', 'base\n'); const value = fixtureState({ 'zshrc.sh': 'base\n' });
      value.faults.publish = mode; saveState(value);
      const result = run(); assert.equal(result.status, 1); assert.notInclude(result.stdout, 'View changes:');
      assert.equal(cached(), 'base\n'); assert.equal(publications().length, 1);
    });
  });
  ['chmodSync', 'renameSync'].forEach((method) => {
    it(`reports confirmed remote success and recovers without another commit after cache ${method} failure`, () => {
      source(); const result = run([], '', {}, cacheFailure(method,
        "String(args[0]).includes('.ballin-backup-cache-') && String(args[0]).endsWith('zshrc.sh')"));
      assert.equal(result.status, 1); assert.include(result.stderr, 'publication confirmed');
      assert.notMatch(result.stdout, /[✔✚✎]/u); assert.isUndefined(cached());
      assert.notInclude(result.stdout, 'View changes:');
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
  for (const target of ['user', 'BallinRepository', '/git/trees/', '/git/blobs/']) {
    it(`fails repository reads when ${target} transport cleanup is incomplete`, () => {
      saveState(fixtureState({ 'zshrc.sh': 'private snapshot\n' }));
      const before = state().head;
      const result = run(['read', 'zshrc.sh'], '', {}, transportCleanupFailure(target));
      assertTransportCleanupFailed(result);
      assert.equal(result.stdout, '');
      assert.equal(state().head, before); assert.lengthOf(mutations(), 0);
      assert.isUndefined(cached());
    });
  }

  for (const row of [
    { target: 'user', faults: { auth: true }, message: 'authentication is required' },
    { target: 'BallinRepository', faults: { query: 'errors' }, message: 'missing or inaccessible' },
    { target: '/git/trees/', faults: { tree: 'unreadable' }, message: 'could not be read completely' },
    { target: '/git/blobs/', faults: { blob: 'unreadable' }, message: 'could not be read completely' },
  ]) {
    it(`preserves the ${row.target} API failure alongside transport cleanup failure`, () => {
      source(); const value = state(); value.faults = row.faults; saveState(value);
      const result = run([], '', {}, transportCleanupFailure(row.target));
      assertTransportCleanupFailed(result); assert.include(result.stderr, row.message);
      assert.lengthOf(mutations(), 0); assert.isUndefined(cached());
    });
  }

  for (const publish of ['success', 'ambiguous', 'malformed']) {
    it(`fails after ${publish} publication transport cleanup even when readback confirms remote success`, () => {
      source(); const value = state(); value.faults.publish = publish; saveState(value);
      const result = run([], '', {}, transportCleanupFailure('BallinPublish'));
      assertTransportCleanupFailed(result);
      assert.include(result.stderr, 'repository publication confirmed');
      assert.include(result.stderr, 'cache contents were not advanced');
      if (publish === 'malformed') assert.include(result.stderr, 'invalid backup metadata or content');
      assert.equal(remote('zshrc.sh'), 'local\n'); assert.isUndefined(cached());
      assert.lengthOf(publications(), 1);
      ok(run()); assert.equal(cached(), 'local\n'); assert.lengthOf(publications(), 1);
    });
  }

  it('preserves rejected publication when its transport cleanup also fails', () => {
    source(); const value = state(); value.faults.publish = 'denied'; saveState(value);
    const result = run([], '', {}, transportCleanupFailure('BallinPublish'));
    assertTransportCleanupFailed(result); assert.include(result.stderr, 'GitHub rejected backup publication');
    assert.equal(state().head, value.head); assert.lengthOf(publications(), 1); assert.isUndefined(cached());
  });

  it('stops candidate selection after transport cleanup failure even for a missing candidate', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n', {}, transportCleanupFailure('repos/fixture-user/ballin-backups'));
    assertTransportCleanupFailed(result); assert.lengthOf(mutations(), 0);
    assert.isNull(config().backup.repository); assert.isFalse(state().exists);
  });

  it('retains known repository creation without initialization or linkage after transport cleanup failure', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n', {}, transportCleanupFailure('user/repos'));
    assertTransportCleanupFailed(result);
    assert.include(result.stdout, 'Repository creation completed');
    assert.include(result.stdout, 'initialization is unconfirmed');
    assert.isTrue(state().exists); assert.lengthOf(mutations(), 1); assert.lengthOf(publications(), 0);
    assert.isNull(config().backup.repository); assert.isUndefined(cached());
  });

  it('retains confirmed protection without linkage after its transport cleanup fails', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n', {}, transportCleanupFailure('ruleset-post'));
    assertTransportCleanupFailed(result);
    assert.include(result.stderr, 'repository protection confirmed');
    assert.include(result.stdout, 'initialized backup remains available');
    assert.lengthOf(state().rulesets, 1); assert.equal(rulesetWrites().length, 1);
    assert.isNull(config().backup.repository); assert.isUndefined(cached());
  });

  it('preserves a local transport failure when removing its directory also fails', () => {
    const preload = transportCleanupFailure('all') + `
      const open = fs.openSync;
      fs.openSync = function(file, ...args) {
        if (path.basename(path.dirname(file)).startsWith('ballin-repository-')) throw new Error('DUMMY_PRIVATE_OPEN_ERROR');
        return open(file, ...args);
      };
    `;
    const result = run([], '', {}, preload);
    assertTransportCleanupFailed(result); assert.include(result.stderr, 'Unable to prepare private backup transport files');
    assert.notInclude(result.stderr, 'DUMMY_PRIVATE_OPEN_ERROR'); assert.lengthOf(mutations(), 0);
  });

  it('reports failed temporary-file cleanup without masking confirmed effects', () => {
    source('base\n'); ok(run()); source();
    const result = run([], '', {}, cacheFailure('rmSync', "String(args[0]).includes('ballin-backup-remote-')"));
    assert.equal(result.status, 1); assert.include(result.stderr, 'temporary-file cleanup is incomplete');
    assert.equal(cached(), 'local\n'); assert.notMatch(result.stdout, /[✔✚✎]/u);
    assert.notInclude(result.stdout, 'View changes:');
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
    assert.equal(run(['read', 'zshrc.sh']).stdout, bytes);
    const opened = run(['open']); ok(opened);
    assert.equal(opened.stdout, 'Opened https://github.com/fixture-user/renamed in your browser.\n');
    assert.deepEqual(state().requests.at(-1)?.payload?.args, ['browse', '--repo', 'https://github.com/fixture-user/renamed']);
    assert.isTrue(fs.lstatSync(cacheRoot).isSymbolicLink()); assert.equal(mutations().length, 0);
    assert.equal(run(['read', '.ballin-backup.json']).status, 1);
    assert.equal(run(['read', 'README.md']).status, 1);
    assert.equal(run(['read', 'nonexistent']).status, 1);
    const failed = state(); failed.faults.tree = { truncated: true }; saveState(failed);
    assert.equal(run(['read', 'zshrc.sh']).status, 1);
    assert.equal(rulesetRequests().length, 0);
  });
  it('renders repository readiness failure with repository-appropriate recovery guidance', () => {
    const value = state(); value.faults.auth = true; saveState(value);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'doctor'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(result.status, 1); assert.include(result.stdout, '`ballin backup setup` to revalidate');
    assert.notInclude(result.stdout, 'Gist'); assert.equal(mutations().length, 0); assert.equal(rulesetRequests().length, 0);
  });
  for (const [label, response, message] of [
    ['DNS', { status: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host' }, 'Unable to connect'],
    ['gh connection diagnostic', { status: 1, stdout: '', stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\nDUMMY_PRIVATE_CONTENT' }, 'Unable to connect'],
    ['timeout', { status: 1, stdout: '', stderr: 'dial tcp: i/o timeout' }, 'request timed out'],
    ['authentication', { status: 1, stdout: '{"status":"401","message":"DUMMY_PRIVATE_CONTENT"}', stderr: '' }, 'authentication is required'],
    ['unconfirmed cause', { status: 1, stdout: '', stderr: 'DUMMY_PRIVATE_CONTENT' }, 'cause is unconfirmed'],
  ] as const) {
    it(`shares sanitized ${label} diagnostics across backup, setup, read, list, open and configured doctor`, () => {
      seedSuccess(); source(); const originalConfig = fs.readFileSync(configPath, 'utf8');
      const value = state(); value.faults.transport = { target: 'user', response: { ...response, signal: null } }; saveState(value);
      for (const args of [[], ['setup'], ['read', 'zshrc.sh'], ['read'], ['read', 'missing'], ['list'], ['open']]) {
        const result = run(args, args[0] === 'setup' ? 'y\n' : '');
        assert.equal(result.status, 1); assert.include(result.stdout + result.stderr, message);
        assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_CONTENT');
        assert.notInclude(result.stdout, 'No supported snapshot found');
        assert.notInclude(result.stdout, 'Options:');
        assert.notInclude(result.stdout, 'Saved snapshots:');
        assert.notInclude(result.stdout, 'No current snapshots');
        if (['read', 'list', 'open'].includes(args[0])) assert.equal(result.stdout, '');
      }
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'doctor'], {
        encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath }),
      });
      assert.equal(result.status, 1); assert.include(result.stdout, message);
      assert.include(result.stdout, 'Resolve the reported error, then rerun `ballin doctor`');
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_CONTENT');
      assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
      assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
      assert.isUndefined(cached()); assert.equal(mutations().length, 0);
    });
  }
  for (const [target, response, message] of [
    ['BallinRepository', { status: 1, stdout: '{"status":"404"}', stderr: 'DUMMY_PRIVATE_CONTENT' }, 'missing or inaccessible'],
    ['/git/trees/', { status: 1, stdout: '', stderr: 'DUMMY_PRIVATE_CONTENT' }, 'could not be read completely'],
    ['/git/blobs/', { status: 1, stdout: '', stderr: 'DUMMY_PRIVATE_CONTENT' }, 'could not be read completely'],
  ] as const) {
    it(`does not expose bytes or infer missing snapshots after incomplete ${target} evidence`, () => {
      saveState(fixtureState({ 'zshrc.sh': 'DUMMY_PRIVATE_SNAPSHOT' }));
      const value = state(); value.faults.transport = { target, response: { ...response, signal: null } }; saveState(value);
      for (const args of [['read', 'zshrc.sh'], ['read'], ['read', 'missing'], ['list']]) {
        const result = run(args);
        assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.include(result.stderr, message);
        assert.notInclude(result.stderr, 'DUMMY_PRIVATE_CONTENT'); assert.notInclude(result.stderr, 'DUMMY_PRIVATE_SNAPSHOT');
        assert.notInclude(result.stderr, 'no supported snapshot found');
      }
      assert.equal(mutations().length, 0); assert.isFalse(fs.existsSync(cacheRoot));
    });
  }
  it('keeps read and open request counts independent of unrelated supported snapshots', () => {
    saveState(fixtureState({ 'zshrc.sh': 'shell\n', gitconfig: 'git\n', mas: 'apps\n' }));
    assert.equal(run(['read', 'mas']).stdout, 'apps\n');
    assert.lengthOf(state().requests, 7);
    const value = state(); value.requests = []; saveState(value);
    ok(run(['open']));
    assert.lengthOf(state().requests, 8);
    assert.equal(state().requests.at(-1)?.endpoint, 'open');
    assert.equal(mutations().length, 0);
    assert.isFalse(fs.existsSync(cacheRoot));
  });
  it('keeps doctor repository readiness independent of repository policy access', () => {
    const value = state(); value.faults.rulesetList = 'denied'; saveState(value);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'doctor'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.isAbove(state().requests.length, 0);
    assert.equal(rulesetRequests().length, 0);
  });

  const browserOrderingPreload = (tty = false, diagnostic = false): string => `
    for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: ${tty} });
    Object.defineProperty(process.stderr, 'columns', { value: 80 });
    const fs = require('fs'); const write = process.stdout.write; const errorWrite = process.stderr.write; const writeSync = fs.writeSync;
    let output = '', feedback = '', combined = '', validated = false;
    process.stdout.write = function(text, ...rest) { output += text; combined += text; return write.call(this, text, ...rest); };
    process.stderr.write = function(text, ...rest) { combined += text; return errorWrite.call(this, text, ...rest); };
    fs.writeSync = function(fd, text, ...rest) { if (fd === 2) { feedback += text; combined += text; } return writeSync.call(this, fd, text, ...rest); };
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'opening-transcript.json'))}, JSON.stringify({ combined })));
    const child = require('child_process'); const spawn = child.spawnSync;
    child.spawnSync = function(command, args, options) {
      if (command === 'gh' && args[0] === 'browse') {
        fs.writeFileSync(${JSON.stringify(path.join(root, 'browser-order.json'))}, JSON.stringify({ output, feedback, validated, args, stdio: options.stdio, host: options.env.GH_HOST }));
        const result = spawn.call(this, command, args, options);
        fs.writeFileSync(${JSON.stringify(path.join(root, 'browser-completion-order.json'))}, JSON.stringify({ output, feedback, status: result.status }));
        return result;
      }
      return spawn.call(this, command, args, options);
    };
    const repository = require(${JSON.stringify(require.resolve('../commands/backup_repository.ts'))});
    const openUrl = repository.repositoryOpenUrl;
    repository.repositoryOpenUrl = function(...args) {
      fs.writeFileSync(${JSON.stringify(path.join(root, 'validation-order.json'))}, JSON.stringify({ feedback, output }));
      if (${diagnostic}) require(${JSON.stringify(require.resolve('../commands/commandHelpers.ts'))}).writeStderrLine('fixture validation diagnostic');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      const url = openUrl.apply(this, args); validated = true; return url;
    };
  `;
  for (const tty of [false, true]) {
    for (const failed of [false, true]) {
      it(`shows immediate opening feedback before delayed validation and ${failed ? 'failed' : 'successful'} browser dispatch in ${tty ? 'TTY' : 'redirected'} output`, () => {
        const value = state(); value.faults.open = failed; saveState(value);
        const result = run(['open'], '', { TERM: 'xterm' }, browserOrderingPreload(tty));
        assert.equal(result.status, failed ? 7 : 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'validation-order.json'), 'utf8')), {
          feedback: tty ? 'Opening...' : 'Opening...\n', output: '',
        });
        const notice = 'Opened https://github.com/fixture-user/ballin-backups in your browser.\n';
        const error = 'ballin backup open: unable to open your browser. Open https://github.com/fixture-user/ballin-backups manually.\n';
        assert.equal(result.stdout, failed ? '' : notice);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'browser-order.json'), 'utf8')), {
          output: '', feedback: tty ? 'Opening...' : 'Opening...\n', validated: true,
          args: ['browse', '--repo', 'https://github.com/fixture-user/ballin-backups'], stdio: 'ignore', host: 'github.com',
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'browser-completion-order.json'), 'utf8')), {
          output: '', feedback: tty ? 'Opening...' : 'Opening...\n', status: failed ? 7 : 0,
        });
        const feedback = tty ? 'Opening...\r\x1b[2K' : 'Opening...\n';
        assert.equal(result.stderr, feedback + (failed ? error : ''));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'opening-transcript.json'), 'utf8')), {
          combined: feedback + (failed ? error : notice),
        });
        assert.equal(state().requests.at(-1)?.endpoint, 'open');
        assert.equal(mutations().length, 0);
        assert.isFalse(fs.existsSync(cacheRoot));
      });
    }
  }
  for (const tty of [false, true]) {
    it(`keeps opening feedback distinct from validation failure in ${tty ? 'TTY' : 'redirected'} output`, () => {
      const value = state(); value.faults.auth = true; saveState(value);
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run(['open'], '', { TERM: 'xterm' }, browserOrderingPreload(tty));
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      const feedback = tty ? 'Opening...\r\x1b[2K' : 'Opening...\n';
      assert.isTrue(result.stderr.startsWith(feedback));
      assert.include(result.stderr, 'authentication');
      assert.notInclude(result.stderr, 'in your browser');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'validation-order.json'), 'utf8')), {
        feedback: tty ? 'Opening...' : 'Opening...\n', output: '',
      });
      assert.isFalse(fs.existsSync(path.join(root, 'browser-order.json')));
      assert.isFalse(state().requests.some((request) => request.endpoint === 'open'));
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.equal(mutations().length, 0); assert.isFalse(fs.existsSync(cacheRoot));
    });
  }
  it('does not erase validation diagnostics when replacing opening feedback', () => {
    const result = run(['open'], '', { TERM: 'xterm' }, browserOrderingPreload(true, true)); ok(result);
    assert.equal(result.stderr, 'Opening...\r\x1b[2Kfixture validation diagnostic\n');
    assert.equal(result.stdout, 'Opened https://github.com/fixture-user/ballin-backups in your browser.\n');
    assert.isTrue(JSON.parse(fs.readFileSync(path.join(root, 'browser-order.json'), 'utf8')).validated);
  });
  for (const failure of ['spawn', 'signal']) {
    it(`reports browser ${failure} failure without exposing child diagnostics`, () => {
      const result = run(['open'], '', {}, `
        const child = require('child_process'); const spawn = child.spawnSync;
        child.spawnSync = function(command, args, options) {
          if (command === 'gh' && args[0] === 'browse') return {
            status: null, signal: ${failure === 'signal' ? "'SIGTERM'" : 'null'},
            error: ${failure === 'spawn' ? "new Error('DUMMY_PRIVATE_BROWSER_ERROR')" : 'undefined'},
            stdout: '', stderr: 'DUMMY_PRIVATE_BROWSER_ERROR'
          };
          return spawn.call(this, command, args, options);
        };
      `);
      assert.equal(result.status, failure === 'spawn' ? 1 : 143);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'unable to open your browser'); assert.include(result.stderr, 'manually');
      assert.include(result.stderr, 'https://github.com/fixture-user/ballin-backups');
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_BROWSER_ERROR');
      assert.equal(mutations().length, 0); assert.isFalse(fs.existsSync(cacheRoot));
    });
  }

  const progressPreload = (nonTTY?: 'stdin' | 'stdout' | 'stderr', columns = 80): string => `
    for (const name of ['stdin', 'stdout', 'stderr']) Object.defineProperty(process[name], 'isTTY', { value: name !== ${JSON.stringify(nonTTY ?? '')} });
    Object.defineProperty(process.stderr, 'columns', { value: ${columns} });
    const fs = require('fs'); const write = fs.writeSync; const child = require('child_process'); const spawn = child.spawnSync;
    let status = '';
    fs.writeSync = function(fd, text, ...rest) { if (fd === 2) status = text === '\\r\\x1b[2K' ? '' : (text.startsWith('\\r\\n') ? text.slice(2) : text); return write.call(this, fd, text, ...rest); };
    child.spawnSync = function(command, args, ...rest) {
      fs.appendFileSync(${JSON.stringify(path.join(root, 'progress.log'))}, JSON.stringify({ args, status }) + '\\n');
      return spawn.call(this, command, args, ...rest);
    };
  `;
  const progressRequests = (): { args: string[]; status: string }[] => fs.readFileSync(path.join(root, 'progress.log'), 'utf8')
    .trim().split('\n').map((line: string) => JSON.parse(line));
  const ttyEnv = { TERM: 'xterm', NO_COLOR: '' };
  for (const { name, diagnostic, nonTTY } of [
    { name: 'without a newline', diagnostic: 'successful fetch diagnostic' },
    { name: 'near the terminal margin without a newline', diagnostic: 'x'.repeat(79) },
    { name: 'with a newline', diagnostic: 'successful fetch diagnostic\n' },
    { name: 'without a newline on redirected stderr', diagnostic: 'successful fetch diagnostic', nonTTY: 'stderr' as const },
  ]) {
    it(`preserves a successful fetch diagnostic ${name} without adding temporary setup-child feedback`, () => {
      fs.cpSync(path.join(repoRoot, 'commands'), path.join(checkout, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(checkout, 'bin'));
      fs.copyFileSync(path.join(repoRoot, 'bin', 'ballin'), path.join(checkout, 'bin', 'ballin'));
      fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
        const args = process.argv.slice(2); const exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);
        if (exact(['rev-parse', '--verify', 'HEAD:commands/backup_snapshots.ts'])) process.stdout.write('a'.repeat(40) + '\\n');
        else if (exact(['fetch', '--quiet', 'origin', '+main:refs/remotes/origin/main'])) process.stderr.write(${JSON.stringify(diagnostic)});
        else if (!exact(['checkout', 'main']) && !exact(['merge', 'origin/main'])) process.exitCode = 2;
      `, { mode: 0o755 });
      const preload = path.join(root, 'successful-fetch-preload.cjs');
      fs.writeFileSync(preload, progressPreload(nonTTY));
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'self-update'], {
        encoding: 'utf8', env: testChildEnvironment({
          HOME: home, PATH: `${bin}${path.delimiter}${path.join(home, '.local', 'bin')}`,
          TMPDIR: path.join(root, 'tmp'), BALLIN_TEST_CONFIG_PATH: configPath,
          NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, ...ttyEnv,
        }),
      });
      ok(result);
      assert.equal(result.stderr, diagnostic);
      assert.equal(result.stdout, 'Updating Ballin...\nBallin updated.\n');
      assert.lengthOf(publications(), 0);
    });
  }
  for (const mode of ['tty', 'stdin', 'stdout', 'stderr', 'dumb', 'NO_COLOR', 'narrow'] as const) {
    it(`leaves configured self-update backup maintenance free of temporary feedback in ${mode} mode`, () => {
      seedCache('zshrc.sh', 'cached bytes\n'); seedSuccess();
      const before = fs.readFileSync(configPath, 'utf8'); const head = state().head;
      const env = { ...ttyEnv };
      if (mode === 'dumb') env.TERM = 'dumb';
      if (mode === 'NO_COLOR') env.NO_COLOR = '1';
      const nonTTY = ['stdin', 'stdout', 'stderr'].includes(mode) ? mode as 'stdin' | 'stdout' | 'stderr' : undefined;
      const result = runSetup('self-update', env, progressPreload(nonTTY, mode === 'narrow' ? 10 : 80)); ok(result);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      const requests = progressRequests();
      const github = requests.filter((request) => request.args[0] === 'api');
      assert.isAbove(github.length, 0);
      assert.isTrue(github.every((request) => request.status === ''));
      assert.isTrue(requests.filter((request) => request.args[0] !== 'api').every((request) => request.status === ''));
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.equal(state().head, head); assert.lengthOf(mutations(), 0);
      assert.equal(cached(), 'cached bytes\n'); assert.equal(fs.readFileSync(statusFile(), 'utf8'), priorSuccess);
    });
  }
  it('preserves self-update maintenance failure guidance without temporary feedback', () => {
    const value = state(); value.faults.query = 'errors'; saveState(value);
    const result = runSetup('self-update', ttyEnv, progressPreload());
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.include(result.stdout, 'Unable to configure backup');
    assert.notInclude(result.stdout, 'Updating...');
    assert.lengthOf(publications(), 0);
  });
  it('preserves optional protection warnings without temporary self-update feedback', () => {
    const value = state(); value.rulesets = []; value.faults.rulesetCreate = 'denied'; saveState(value);
    const result = runSetup('self-update', ttyEnv, progressPreload()); ok(result);
    assert.equal(result.stderr, '');
    assert.include(result.stdout, 'Optional GitHub branch protection was not enabled with the current permissions');
    assert.notInclude(result.stdout, 'Updating...');
    assert.lengthOf(publications(), 0);
  });
  it('leaves self-update feedback absent without a configured backup', () => {
    unconfigured();
    const result = runSetup('self-update', ttyEnv, progressPreload()); ok(result);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.lengthOf(state().requests, 0);
  });
  it('shows create status before creation and clears before setup results', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\nn\n', ttyEnv, progressPreload()); ok(result);
    assert.include(result.stderr, 'Creating and initializing private backup...\r\x1b[2K');
    assert.equal(progressRequests().find((r) => r.args.includes('user/repos'))?.status, 'Creating and initializing private backup...');
    assert.notInclude(result.stdout, 'Creating and initializing'); assert.include(result.stdout, 'Private backup created:');
  });
  it('clears failed creation status before existing recovery guidance', () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.create = 'reject'; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n', ttyEnv, progressPreload());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Creating and initializing private backup\.\.\.\r\x1b\[2Kballin backup setup:/);
    assert.include(result.stdout, 'Remote creation or initialization may already have occurred');
    assert.notInclude(result.stdout, 'Private backup created:');
  });
  it('shows reconnect status during revalidation and leaves cancellation quiet', () => {
    unconfigured();
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\nn\n', ttyEnv, progressPreload()); ok(result);
    assert.include(result.stderr, 'Checking existing private backup...\r\x1b[2K');
    assert.isTrue(progressRequests().some((r) => r.status === 'Checking existing private backup...'));
    unconfigured();
    const cancelled = run(['setup'], 'y\nreconnect\n\nn\nn\n', ttyEnv, progressPreload());
    assert.equal(cancelled.status, 1); assert.equal(cancelled.stderr.includes('Checking existing'), false);
    assert.include(cancelled.stdout, 'Backup setup cancelled;');
  });
  it('shows backup status before quiet work and removes it on success and failure', () => {
    source(); const result = run([], '', ttyEnv, progressPreload()); ok(result);
    assert.match(result.stderr, /^Backing up\.\.\.\r\x1b\[2K$/);
    assert.isTrue(progressRequests().some((r) => r.status === 'Backing up...'));
    const value = state(); value.faults.query = 'errors'; saveState(value);
    const failed = run([], '', ttyEnv, progressPreload());
    assert.equal(failed.status, 1); assert.match(failed.stderr, /^Backing up\.\.\.\r\x1b\[2Kballin backup:/);
    assert.notMatch(failed.stdout, /[✔✚✎✖]/u);
  });
  it('keeps progress active after previous-run context during changed, no-op and failed backups', () => {
    source(); seedSuccess();
    for (const outcome of ['changed', 'no-op', 'failed']) {
      fs.rmSync(path.join(root, 'progress.log'), { force: true });
      if (outcome === 'failed') { const value = state(); value.faults.query = 'errors'; saveState(value); }
      const result = run([], '', { ...ttyEnv, TZ: 'America/Los_Angeles' }, progressPreload());
      assert.equal(result.status, outcome === 'failed' ? 1 : 0, result.stderr);
      assert.match(result.stdout, /^Last successful backup: .+ GMT-0[78]:00\n/);
      assert.lengthOf(result.stdout.match(/Last successful backup:/g), 1);
      assert.notInclude(result.stdout, 'Last recorded successful backup');
      if (outcome === 'changed') assert.include(result.stdout, `/commit/${state().head}\n`);
      else assert.notInclude(result.stdout, 'View changes:');
      const requests = progressRequests();
      assert.isTrue(requests.some((request) => request.args.some((arg) => arg.endsWith('.zshrc'))));
      assert.isTrue(requests.some((request) => request.args.includes('graphql')));
      assert.isTrue(requests.every((request) => request.status === 'Backing up...'), JSON.stringify(requests));
      assert.match(result.stderr, /^Backing up\.\.\.\r\x1b\[2K/);
    }
    assert.equal(publications().length, 1);
  });
  it('creates and confirms the marker and explanatory README before persisting reviewed local choices', () => {
    unconfigured(); const value = state(); value.exists = false; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n\n'); ok(result);
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.equal(config().backup.includeSensitive, 'false');
    assert.equal(config().update.backup, 'false');
    assert.include(result.stdout, 'Automatically run `ballin backup` as part of `ballin update`? [y/N]');
    assert.include(result.stdout, '\nSelected GitHub.com account: fixture-user\nCandidate backup: https://github.com/fixture-user/ballin-backups\n\nSensitive sources');
    assert.include(result.stdout, 'Private backup created: https://github.com/fixture-user/ballin-backups\n');
    assert.include(result.stdout, '"update.backup" set to: "false"\nBackup setup complete.\n');
    assertSavedSensitiveChoice(result, 'false');
    assert.deepEqual(Object.keys(state().commits[state().head].files).sort(), ['.ballin-backup.json', 'README.md']);
    assert.isFalse(fs.existsSync(cacheRoot)); assert.equal(mutations().length, 3);
    assert.isBelow(result.stdout.indexOf('Selected GitHub.com account: fixture-user'), result.stdout.indexOf('Confirm this destination'));
    assert.notInclude(result.stdout, 'zshrc.sh:');
    assert.include(result.stdout, 'GitHub branch protection enabled.');
    const requests = state().requests;
    const created = requests.findIndex((request) => request.endpoint === 'user/repos');
    const initialized = requests.findIndex((request) => request.payload?.query?.includes('BallinPublish'));
    const policyLookup = requests.findIndex((request) => request.endpoint.includes('/rulesets?'));
    const policyCreate = requests.findIndex((request) => request.endpoint.endsWith('/rulesets') && request.method === 'POST');
    const policyDetail = requests.findIndex((request) => /\/rulesets\/\d+\?/u.test(request.endpoint));
    assert.isBelow(created, initialized); assert.isBelow(initialized, policyLookup);
    assert.isBelow(policyLookup, policyCreate); assert.isBelow(policyCreate, policyDetail);
  });
  [
    { name: 'unsupported capability', faults: { rulesetCreate: 'plan' }, message: undefined },
    { name: 'missing administration', faults: { rulesetCreate: 'denied' }, message: 'current permissions' },
    { name: 'ordinary rejection', faults: { rulesetCreate: 'reject' }, message: 'could not be confirmed' },
    { name: 'transient response', faults: { rulesetCreate: 'server' }, message: 'protection is unconfirmed' },
    { name: 'ambiguous no-effect response', faults: { rulesetCreate: 'ambiguous-no-effect' }, message: 'protection is unconfirmed' },
    { name: 'missing created resource', faults: { rulesetCreate: 'no-effect' }, message: 'protection is unconfirmed' },
    { name: 'unavailable confirmation', faults: { rulesetCreate: 'confirmation-failure' }, message: 'protection is unconfirmed' },
    { name: 'malformed policy detail', faults: { rulesetDetail: 'malformed' }, message: 'protection is unconfirmed' },
  ].forEach(({ name, faults, message }) => {
    it(`links the valid backup after ${name}`, () => {
      unconfigured(); seedCache('zshrc.sh', 'untrusted\n');
      const value = state(); value.exists = false; value.faults = faults; saveState(value);
      const result = run(['setup'], 'y\ncreate\n\nn\ny\n');
      ok(result);
      const confirmation = 'Confirm this destination and source selection? [y/N] ';
      assert.include(result.stdout, `Ballin also attempts optional GitHub branch protection.\n${confirmation}`);
      const outcomeOutput = result.stdout.slice(result.stdout.indexOf(confirmation) + confirmation.length);
      if (message) assert.include(outcomeOutput, message);
      else assert.notInclude(outcomeOutput, 'branch protection');
      assert.include(result.stdout, 'https://github.com/fixture-user/ballin-backups');
      assert.deepEqual(config().backup.repository, fixtureDestination); assert.isUndefined(cached());
      assert.deepEqual(Object.keys(state().commits[state().head].files).sort(), ['.ballin-backup.json', 'README.md']);
      assert.equal(state().requests.filter((request) => request.endpoint === 'user/repos').length, 1);
      assert.equal(rulesetWrites().length, 1); assert.equal(mutations().length, 3);
    });
  });
  it('revalidates and protects a linked repository after an earlier permission-limited attempt', () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.rulesetCreate = 'denied'; saveState(value);
    ok(run(['setup'], 'y\ncreate\n\nn\ny\n'));
    const retry = state(); delete retry.faults.rulesetCreate; saveState(retry);
    const revalidated = run(['setup']); ok(revalidated);
    assert.include(revalidated.stdout, 'GitHub branch protection enabled.');
    assert.deepEqual(config().backup.repository, fixtureDestination);
    assert.equal(state().requests.filter((request) => request.endpoint === 'user/repos').length, 1);
    assert.equal(rulesetWrites().length, 2); assert.lengthOf(state().rulesets, 1);
  });
  it('links an unprotected reconnect without administration access', () => {
    unconfigured(); seedCache('zshrc.sh', 'untrusted\n');
    const value = state(); value.rulesets = []; value.faults.rulesetCreate = 'denied'; saveState(value);
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\n');
    ok(result); assert.include(result.stdout, 'current permissions'); assert.include(result.stdout, 'backup setup can continue normally');
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.isUndefined(cached());
    assert.equal(state().requests.filter((request) => request.endpoint === 'user/repos').length, 0);
    assert.equal(rulesetWrites().length, 1);
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
      assert.include(result.stdout, 'Backup setup cancelled;');
      assert.equal(result.stderr, '');
      assert.notInclude(result.stdout, '"backup.includeSensitive" set to:');
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
    assert.include(result.stdout, `${JSON.stringify(path.join(home, '.zshrc'))} -> ${JSON.stringify(fs.realpathSync(external))}`);
    assert.include(result.stdout, 'Unavailable now: pipx,');
    assert.notInclude(result.stdout, 'private-review-secret'); assert.equal(mutations().length, 0);
    assert.notInclude(result.stdout, '"backup.includeSensitive" set to:');
    assert.include(result.stdout, 'Confirm this destination');
  });
  it('skips all sensitive discovery after declining and aborts selected inaccessible sources', () => {
    unconfigured(); fs.symlinkSync(path.join(home, '.zshrc'), path.join(home, '.zshrc'));
    const failed = run(['setup'], 'y\nreconnect\n\ny\ny\n'); assert.equal(failed.status, 1);
    assert.include(failed.stdout, 'source access failed'); assert.equal(mutations().length, 0);
    assert.equal(config().backup.includeSensitive, 'true');
    assert.notInclude(failed.stdout, '"backup.includeSensitive" set to:');
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
  it('stops backup setup when installed config migration fails before any remote request', () => {
    const before = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(path.join(checkout, 'config', 'updateConfig.ts'), "process.stderr.write('fixture migration failed\\n'); process.exitCode = 1;\n");
    const result = run(['setup']);
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'fixture migration failed');
    assert.include(result.stderr, 'ballin backup setup: unable to create or update config');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.equal(state().requests.length, 0);
    assert.isFalse(fs.existsSync(cacheRoot));
  });

  it('reconnects without write permission or a cached base and restores only eligible preferences with local precedence', () => {
    const local = { backup: { id: null, host: 'preserved.test', repository: null, includeSensitive: 'true' },
      update: { cleanup: 'invalid', npm: false }, analytics: {}, custom: { preserve: true } };
    saveConfig(local); seedCache('zshrc.sh', 'stale base\n');
    const value = fixtureState({ ballin_config: JSON.stringify({ update: { cleanup: true, npm: true, nvm: false, selfUpdate: 'false', softwareupdate: true, backup: true },
      analytics: { enabled: 'false' }, backup: { id: 'ignored', repository: { id: 'other' }, includeSensitive: true }, custom: 'ignored' }) });
    value.faults.publish = 'denied'; value.faults.rulesetCreate = 'denied'; saveState(value);
    ok(run(['setup'], 'y\nreconnect\n\nn\ny\nn\n'));
    const restored = config(); assert.equal(restored.update.cleanup, 'invalid'); assert.isFalse(restored.update.npm);
    assert.equal(restored.update.nvm, 'false'); assert.equal(restored.update.softwareupdate, 'true');
    assert.equal(restored.update.selfUpdate, 'false'); assert.equal(restored.update.backup, 'false');
    assert.equal(restored.analytics.enabled, 'false'); assert.deepEqual(restored.custom, { preserve: true });
    assert.equal(restored.backup.host, 'preserved.test'); assert.equal(restored.backup.includeSensitive, 'false');
    assert.isFalse(fs.existsSync(cacheRoot)); assert.equal(mutations().length, 0);
    assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'GET']);
  });
  it('reports retained unrecognized entries during reconnect without changing them', () => {
    unconfigured(); saveState(fixtureState({ 'unrecognized-file': 'saved data\n' }));
    const result = run(['setup'], 'y\nreconnect\n\nn\nn\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unrecognized backup entries: 1. Ballin will leave them unchanged.');
    assert.equal(remote('unrecognized-file'), 'saved data\n');
    assert.equal(mutations().length, 0);
    assert.equal(result.stderr, '');
  });
  (['true', 'false'] as const).forEach((preference) => {
    it(`confirms the independently reviewed sensitive-source choice once after reconnect saves ${preference}`, () => {
      unconfigured(); const before = config(); before.backup.includeSensitive = preference === 'true' ? 'false' : 'true'; saveConfig(before);
      const result = run(['setup'], `y\nreconnect\n\n${preference === 'true' ? 'y' : 'n'}\ny\nn\n`); ok(result);
      assert.include(result.stdout, 'Include sensitive sources? [y/N]');
      assert.equal(config().backup.includeSensitive, preference);
      assertSavedSensitiveChoice(result, preference);
      assert.include(result.stdout, 'Private backup reconnected: https://github.com/fixture-user/ballin-backups\n');
      assert.notInclude(result.stdout, 'Unrecognized backup entries:');
      assert.include(result.stdout, 'Stop backups from other installations before running `ballin backup` here.');
      assert.include(result.stdout, 'Reconnect does not authorize overwriting different saved data.');
      assert.include(result.stdout, 'Backup setup complete.');
      assert.notInclude(result.stdout, `"backup.includeSensitive" set to: "${before.backup.includeSensitive}"`);
    });
  });
  ['n\n', '', 'y', 'y\n', 'Y\n', '\n'].forEach((automatic) => {
    it(`defaults automatic backups off unless explicitly enabled after reconnect: ${JSON.stringify(automatic)}`, () => {
      unconfigured(); ok(run(['setup', 'ballin-backups'], `y\nreconnect\nn\ny\n${automatic}`));
      assert.equal(config().update.backup, ['y', 'y\n', 'Y\n'].includes(automatic) ? 'true' : 'false');
    });
  });
  it('retains a configured destination when the subsequent automatic preference save fails', () => {
    unconfigured(); const value = config(); value.update.backup = {}; saveConfig(value);
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\n\n'); assert.equal(result.status, 1);
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.include(result.stdout, 'preference was not saved');
    assert.equal(config().backup.includeSensitive, 'false');
    assertSavedSensitiveChoice(result, 'false');
  });
  it('retains atomic destination persistence if a later automatic-backup write is interrupted', () => {
    unconfigured(); const preload = `const fs=require('fs'); const original=fs.writeFileSync; let saves=0;
      fs.writeFileSync=function(file,...args) { if(typeof file==='number' && ++saves===2) {
        original.call(this,file,'partial'); throw new Error('fixture interrupted preference write');
      } return original.call(this,file,...args); };`;
    const result = run(['setup'], 'y\nreconnect\n\nn\ny\ny\n', {}, preload);
    assert.equal(result.status, 1); assert.include(result.stdout, 'preference was not saved');
    assert.notInclude(result.stdout, 'Backup setup complete.');
    assert.deepEqual(config().backup.repository, fixtureDestination); assert.equal(config().update.backup, 'false');
    assert.equal(config().backup.includeSensitive, 'false');
    assertSavedSensitiveChoice(result, 'false');
    assert.notInclude(result.stdout, '"backup.includeSensitive" set to: "true"');
    assert.notInclude(result.stdout, '"update.backup" set to:');
  });
  it('revalidates by stable identity after a rename and preserves local choices without prompting', () => {
    const value = state(); value.name = 'renamed'; value.login = 'renamed-user';
    value.rulesets = [fixtureRuleset({ source: 'renamed-user/renamed' })];
    saveState(value); seedCache('zshrc.sh', 'base\n');
    const result = run(['setup', 'renamed']); ok(result); assert.equal(config().backup.repository.name, 'renamed');
    assert.include(result.stdout, 'Validated private backup: https://github.com/renamed-user/renamed\nSensitive sources: included\nAutomatic backup during update: disabled\n');
    assert.notInclude(result.stdout, 'https://github.com/fixture-user/ballin-backups');
    assert.notInclude(result.stdout, '"backup.includeSensitive" set to:');
    assert.notInclude(result.stdout, 'Include sensitive sources');
    assert.equal(config().backup.includeSensitive, 'true'); assert.equal(config().update.backup, 'false');
    assert.equal(cached(), 'base\n'); assert.equal(mutations().length, 0);
    assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'GET']);
    assert.equal(run(['setup', 'wrong']).status, 1);
  });
  ['missing', 'denied'].forEach((fault) => {
    it(`never creates a replacement when reconnect lookup is ${fault}`, () => {
      unconfigured(); const value = state(); value.faults.candidate = fault; saveState(value);
      assert.equal(run(['setup'], 'y\nreconnect\n\nn\ny\n').status, 1); assert.equal(mutations().length, 0);
    });
  });
  it('creates a fresh private backup at a redirected name without writing to the renamed repository', () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.candidate = 'redirect'; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\nn\n'); ok(result);
    const warning = 'Creating a backup here ends that redirect';
    assert.include(result.stdout, warning);
    assert.isBelow(result.stdout.indexOf(warning), result.stdout.indexOf('Confirm this destination'));
    assert.deepEqual(config().backup.repository, fixtureDestination);
    const creates = mutations().filter((request) => request.endpoint === 'user/repos');
    assert.lengthOf(creates, 1); assert.equal(creates[0].payload?.private, true);
    assert.equal(creates[0].payload?.name, fixtureDestination.name);
    assert.isTrue(publications().every((request) => JSON.stringify(request.payload).includes(fixtureDestination.id)));
    assert.isFalse(mutations().some((request) => JSON.stringify(request.payload).includes('R_renamed')));
  });
  ['n\n', ''].forEach((answer) => it(`leaves a redirected name unchanged when final confirmation is ${JSON.stringify(answer)}`, () => {
    unconfigured(); const value = state(); value.exists = false; value.faults.candidate = 'redirect'; saveState(value);
    seedCache('zshrc.sh', 'unchanged\n'); const before = config();
    const result = run(['setup'], `y\ncreate\n\nn\n${answer}`);
    assert.equal(result.status, 1); assert.include(result.stdout, 'Creating a backup here ends that redirect');
    assert.deepEqual(config(), before); assert.equal(cached(), 'unchanged\n'); assert.lengthOf(mutations(), 0);
  }));
  it('revalidates a configured backup through its old name using stable identity', () => {
    const before = config(); seedCache('zshrc.sh', 'unchanged\n');
    const value = state(); value.name = 'renamed'; value.faults.candidateAlias = fixtureDestination.name;
    value.rulesets = [fixtureRuleset({ source: 'fixture-user/renamed' })]; saveState(value);
    const result = run(['setup', fixtureDestination.name]); ok(result);
    assert.equal(config().backup.repository.name, 'renamed');
    assert.equal(config().backup.repository.id, before.backup.repository.id);
    assert.equal(config().backup.includeSensitive, before.backup.includeSensitive);
    assert.equal(config().update.backup, before.update.backup);
    assert.equal(cached(), 'unchanged\n'); assert.lengthOf(mutations(), 0);
    assert.notInclude(result.stdout, 'Creating a backup here ends that redirect');
    assert.notInclude(result.stdout, 'Confirm this destination');
  });
  it('does not repeat ambiguous creation after a redirected-name lookup', () => {
    unconfigured(); const value = state(); value.exists = false;
    value.faults.candidate = 'redirect'; value.faults.create = 'ambiguous'; saveState(value);
    const result = run(['setup'], 'y\ncreate\n\nn\ny\n');
    assert.equal(result.status, 1); assert.isNull(config().backup.repository);
    assert.lengthOf(mutations().filter((request) => request.endpoint === 'user/repos'), 1);
    assert.lengthOf(publications(), 0);
    assert.isFalse(mutations().some((request) => JSON.stringify(request.payload).includes('R_renamed')));
  });
  it('does not reconnect to a different repository through a renamed-name redirect', () => {
    unconfigured(); const value = state(); value.faults.candidate = 'redirect'; saveState(value);
    assert.equal(run(['setup'], 'y\nreconnect\n\n').status, 1);
    assert.isNull(config().backup.repository); assert.lengthOf(mutations(), 0);
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
    assert.notInclude(result.stdout, '"backup.includeSensitive" set to:');
    ok(run(['setup'], 'y\nreconnect\n\nn\ny\nn\n')); assert.equal(mutations().length, 3);
    assert.equal(rulesetWrites().length, 1);
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
    assert.equal(config().backup.includeSensitive, 'true');
    assert.notInclude(result.stdout, '"backup.includeSensitive" set to:');
    assert.equal(mutations().length, 0);
  });
  it('disconnects locally and retries incomplete cleanup while writes stay disabled', () => {
    seedCache('zshrc.sh', 'base\n'); const before = config(); before.update.backup = 'true'; saveConfig(before);
    const result = run(['disconnect'], '', {}, cacheFailure('rmSync', `args[0] === ${JSON.stringify(cacheRoot)}`));
    assert.equal(result.status, 1); assert.include(result.stdout, 'cleanup is incomplete');
    assert.isNull(config().backup.repository); assert.isNull(config().backup.id); assert.equal(config().update.backup, 'false');
    assert.equal(config().backup.includeSensitive, 'true'); assert.equal(config().backup.host, before.backup.host);
    assert.equal(run().status, 1);
    const disconnected = run(['disconnect']); ok(disconnected);
    assert.equal(disconnected.stdout, 'Backup disconnected. Your remote backup and GitHub authentication are unchanged.\n');
    assert.isFalse(fs.existsSync(cacheRoot));
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

  describe('behavioral analytics', () => {
    let capture: ReturnType<typeof createAnalyticsCapture>;
    const observedRun = (preload = '') => run([], '', capture.env, preload);
    const assertOutcome = (status: string): void => {
      const events: CapturedAnalyticsEvent[] = capture.readEvents();
      assert.deepEqual(events.filter((event) => event.schemaVersion === 2), [{
        schemaVersion: 2, installId: fixtureInstallId,
        dateBucket: new Date().toISOString().slice(0, 10), event: 'backup.run', status,
      }]);
      const commands = events.filter((event) => event.schemaVersion === 1);
      assert.lengthOf(commands, 1);
      assert.equal(commands[0].command, 'ballin backup');
      assert.equal(commands[0].status, status);
    };
    beforeEach(() => {
      const value = config(); value.analytics.enabled = 'true'; saveConfig(value);
      capture = createAnalyticsCapture(root);
    });

    it('emits one success for repository publication and one for an unchanged backup', () => {
      source(); ok(observedRun()); assertOutcome('success');
      capture.clear();
      ok(observedRun()); assertOutcome('success');
      assert.lengthOf(publications(), 1);
    });

    it('keeps excluded-source and unavailable-tool handling successful without source events', () => {
      const value = config(); value.backup.includeSensitive = 'false'; saveConfig(value);
      source(); saveState(fixtureState({ 'zshrc.sh': 'retained private source\n', pipx: 'retained unavailable tool\n' }));
      ok(observedRun()); assertOutcome('success');
      assert.equal(remote('zshrc.sh'), 'retained private source\n');
      assert.equal(remote('pipx'), 'retained unavailable tool\n');
    });

    for (const fault of ['auth', 'collection', 'conflict', 'cache preflight']) {
      it(`emits one failure after repository ${fault} failure`, () => {
        source();
        if (fault === 'auth') { const value = state(); value.faults.auth = true; saveState(value); }
        if (fault === 'collection') {
          fs.rmSync(path.join(bin, 'cat'));
          fs.writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
        }
        if (fault === 'conflict') saveState(fixtureState({ 'zshrc.sh': 'conflicting remote\n' }));
        if (fault === 'cache preflight') fs.symlinkSync(home, cacheRoot);

        const result = observedRun();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.lengthOf(publications(), 0);
        assertOutcome('failure');
      });
    }

    for (const mode of ['ambiguous', 'malformed']) {
      it(`emits once after ${mode} publication is confirmed by internal readback`, () => {
        source(); const value = state(); value.faults.publish = mode; saveState(value);
        ok(observedRun()); assertOutcome('success');
        assert.lengthOf(publications(), 1);
        assert.isAbove(state().requests.filter((request) => request.payload?.query?.includes('BallinRepository')).length, 1);
        assert.equal(cached(), 'local\n');
      });
    }

    for (const mode of ['advance', 'denied', 'orphan', 'wrong-readback']) {
      it(`emits one failure after ${mode} publication reaches its final outcome`, () => {
        source(); seedCache('zshrc.sh', 'base\n');
        const value = fixtureState({ 'zshrc.sh': 'base\n' }); value.faults.publish = mode; saveState(value);
        const result = observedRun();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.lengthOf(publications(), 1); assert.equal(cached(), 'base\n');
        assertOutcome('failure');
      });
    }

    for (const method of ['copyFileSync', 'chmodSync', 'renameSync', 'rmSync']) {
      it(`emits one failure for cache ${method} after confirmed remote publication`, () => {
        source();
        const condition = method === 'copyFileSync'
          ? "String(args[1]).includes('.ballin-backup-cache-')"
          : "String(args[0]).includes('.ballin-backup-cache-')";
        const result = observedRun(cacheFailure(method, condition));
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'publication confirmed');
        assert.equal(remote('zshrc.sh'), 'local\n');
        assert.lengthOf(publications(), 1); assertOutcome('failure');
      });
    }

    it('reports a failed no-op when unchanged remote state cannot hydrate its cache', () => {
      source(); ok(observedRun()); fs.rmSync(cache, { recursive: true }); capture.clear();
      const result = observedRun(cacheFailure('copyFileSync', "String(args[1]).includes('.ballin-backup-cache-')"));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'state confirmed unchanged');
      assert.lengthOf(publications(), 1); assertOutcome('failure');
    });

    it('includes publication transport cleanup in the terminal failure despite successful readback', () => {
      source(); const result = observedRun(transportCleanupFailure('BallinPublish'));
      assertTransportCleanupFailed(result);
      assert.include(result.stderr, 'repository publication confirmed');
      assert.equal(remote('zshrc.sh'), 'local\n');
      assertOutcome('failure');
    });
  });
});
