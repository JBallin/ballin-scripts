const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runBackupVerify } = require('../commands/backup_verify.ts');
const { compareSnapshotState } = require('../commands/backup_comparison.ts');
const { repositoryCacheDirectory } = require('../commands/backup_repository.ts');
const { projectPortablePreferences } = require('../config/portable.ts');
const { fixtureDestination, fixtureState, requestFixture, commitFixture, installRepositoryFixture } = require('./helpers/repository.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');
import type { FixtureState } from './helpers/repository.ts';
import type { VerifyOptions } from '../commands/backup_verify.ts';

describe('current backup verification', function() {
  this.timeout(10000);
  let root: string; let home: string; let bin: string; let checkout: string;
  let configPath: string; let cacheRoot: string; let cache: string; let state: FixtureState;
  let config: Record<string, unknown>; let options: VerifyOptions;
  const projected = () => `${JSON.stringify(projectPortablePreferences(config), null, 2)}\n`;
  const writeConfig = () => fs.writeFileSync(configPath, JSON.stringify(config));
  const setRemote = (files: Record<string, string>) => { state = fixtureState({ ballin_config: projected(), ...files }); };
  const source = (contents = 'local\n') => {
    (config.backup as Record<string, unknown>).includeSensitive = true; writeConfig();
    fs.writeFileSync(path.join(home, '.zshrc'), contents);
  };
  const seedCache = (contents: string) => { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'zshrc.sh'), contents); };
  const run = (args: string[] = [], verify = runBackupVerify) => {
    let output = ''; const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof original;
    const before = JSON.stringify(state.commits); const head = state.head; const configBytes = fs.readFileSync(configPath);
    let status;
    try { status = verify(args, options); } finally { process.stdout.write = original; }
    assert.equal(JSON.stringify(state.commits), before);
    assert.equal(state.head, head);
    assert.isTrue(fs.readFileSync(configPath).equals(configBytes));
    assert.isFalse(state.requests.some(r => r.payload?.query?.includes('mutation') || r.endpoint.includes('gist') || r.endpoint === 'user/repos'));
    for (const secret of ['PRIVATE_SECRET', 'PRIVATE_FILENAME', 'PRIVATE_ERROR', root, fixtureDestination.id]) assert.notInclude(output, secret);
    return { status, output };
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-verify-test-'));
    home = path.join(root, 'home'); bin = path.join(root, 'bin'); checkout = path.join(home, '.ballin-scripts');
    fs.mkdirSync(bin); fs.mkdirSync(checkout, { recursive: true });
    configPath = path.join(checkout, 'ballin.config.json'); cacheRoot = path.join(checkout, '.backup-cache');
    cache = repositoryCacheDirectory(cacheRoot, fixtureDestination);
    config = { backup: { repository: fixtureDestination, includeSensitive: false }, update: { cleanup: 'true' }, analytics: { enabled: 'false' } };
    writeConfig(); setRemote({});
    options = { configPath, homeDir: home, cacheRoot, env: { HOME: home, PATH: bin }, repository: {
      env: { HOME: home, PATH: bin }, runCommand: (_command: string, args: string[], opts: object) => requestFixture(state, args, opts),
    } };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes exact current preferences with expected absent/unavailable sources', () => {
    const result = run(); assert.equal(result.status, 0); assert.equal(result.output, 'Backup matches the current sources checked.\n');
    assert.isFalse(fs.existsSync(cacheRoot));
  });
  for (const failed of [false, true]) it(`handles a qualified inventory ${failed ? 'failure' : 'match'} through verification`, () => {
    const crypto = require('crypto'); const helpers = require('../commands/commandHelpers.ts');
    const originalHash = crypto.createHash; const originalRun = helpers.runCommand;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const version = Object.getOwnPropertyDescriptor(process, 'version')!;
    const packageRoot = path.join(root, 'npm-package'); fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'bin/npm-cli.js'), 'fixture', { mode: 0o700 });
    fs.symlinkSync(path.join(packageRoot, 'bin/npm-cli.js'), path.join(bin, 'npm'));
    fs.symlinkSync('/bin/bash', path.join(bin, 'bash')); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    setRemote({ npm_global: 'npm-current\n' });
    const reload = () => {
      delete require.cache[require.resolve('../commands/backup_collectors.ts')];
      delete require.cache[require.resolve('../commands/backup_verify.ts')];
      return require('../commands/backup_verify.ts').runBackupVerify;
    };
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'version', { value: 'v24.21.0' });
      crypto.createHash = (algorithm: string) => algorithm !== 'sha256' ? originalHash(algorithm) : ({ update() { return this; }, digest() { return '5b18b54d55d52474a913ee469f117a2010452e42adaefa62c0078d5c2609a5d8'; } });
      helpers.runCommand = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: (string | number)[] }) => {
        if (command !== process.execPath) return originalRun(command, args, opts);
        assert.equal(command, process.execPath); assert.include(args, '--update-notifier=false'); assert.equal(opts.env.HOME, home);
        fs.writeSync(opts.stdio[1], Buffer.from('npm-current'));
        return { status: failed ? 1 : 0, signal: null, stdout: 'npm-current', stderr: 'PRIVATE_ERROR' };
      };
      const result = run(['--verbose'], reload()); assert.equal(result.status, failed ? 1 : 0);
      assert.include(result.output, `npm_global: ${failed ? 'unchecked' : 'match'}`);
    } finally {
      crypto.createHash = originalHash; helpers.runCommand = originalRun;
      Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'version', version); reload();
    }
  });
  it('shows every canonical outcome in verbose without exposing excluded sources', () => {
    fs.writeFileSync(path.join(home, '.zshrc'), 'PRIVATE_SECRET');
    const original = fs.statSync;
    fs.statSync = (file: string, ...args: unknown[]) => {
      if (file === path.join(home, '.zshrc') || file === path.join(bin, 'pipx')) throw new Error('PRIVATE_ERROR');
      return original(file, ...args);
    };
    try {
      const result = run(['--verbose']); assert.equal(result.status, 0);
      assert.equal(result.output.trim().split('\n').length, 29);
      assert.include(result.output, 'zshrc.sh: excluded'); assert.include(result.output, 'mas: skip');
    } finally { fs.statSync = original; }
  });
  it('retains saved counterparts for absent and unavailable sources', () => {
    source(); fs.rmSync(path.join(home, '.zshrc')); setRemote({ 'zshrc.sh': 'PRIVATE_SECRET', mas: 'PRIVATE_SECRET' });
    const result = run(); assert.equal(result.status, 0); assert.include(result.output, 'zshrc.sh: saved-unverified'); assert.include(result.output, 'mas: saved-unverified');
  });
  it('distinguishes retired names from unexpected entries by count only', () => {
    setRemote({ 'brackets_settings.json': 'PRIVATE_SECRET', PRIVATE_FILENAME: 'PRIVATE_SECRET' });
    const result = run(['--verbose']); assert.equal(result.status, 1); assert.include(result.output, '1 unexpected repository entries');
    assert.include(result.output, 'brackets_settings.json: known retired snapshot retained');
  });
  it('allows known retired material without claiming it is current', () => {
    setRemote({ 'brackets_extensions': 'PRIVATE_SECRET' }); assert.equal(run().status, 0);
  });
  it('rejects marker-only inventory even when all local sources are absent', () => {
    state = fixtureState(); fs.rmSync(configPath); // Keep destination config separate from the catalog source.
    configPath = path.join(root, 'config.json'); writeConfig(); options.configPath = configPath;
    const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'No usable backup snapshots');
  });
  for (const [label, local, remote, base, status, text] of [
    ['without cache', 'same\n', 'same\n', undefined, 0, 'matches'],
    ['stale cache', 'same\n', 'same\n', 'old\n', 0, 'matches'],
    ['clean cache', 'same\n', 'same\n', 'same\n', 0, 'matches'],
    ['missing coverage', 'local\n', undefined, undefined, 1, 'missing'],
    ['remote deletion', 'local\n', undefined, 'base\n', 1, 'conflict'],
    ['missing base', 'local\n', 'remote\n', undefined, 1, 'conflict'],
    ['pending local change', 'local\n', 'remote\n', 'remote\n', 1, 'different'],
    ['remote-only change', 'base\n', 'remote\n', 'base\n', 1, 'conflict'],
    ['three divergent values', 'local\n', 'remote\n', 'base\n', 1, 'conflict'],
    ['empty normalized', '', 'empty\n', undefined, 0, 'matches'],
    ['remote zero bytes', '', '', '', 1, 'different'],
    ['remote missing newline', 'local', 'local', 'local', 1, 'different'],
  ] as const) it(`compares ${label}`, () => {
    source(local); setRemote(remote === undefined ? {} : { 'zshrc.sh': remote }); if (base !== undefined) seedCache(base);
    const result = run(); assert.equal(result.status, status); assert.include(result.output, text);
  });
  it('does not follow cache symlinks or change their permissions', () => {
    source(); setRemote({ 'zshrc.sh': 'remote\n' }); fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(root, 'outside'), 'PRIVATE_SECRET'); fs.symlinkSync(path.join(root, 'outside'), path.join(cache, 'zshrc.sh'));
    const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'cache unreadable');
    assert.isTrue(fs.lstatSync(path.join(cache, 'zshrc.sh')).isSymbolicLink());
  });
  it('current equality passes without touching an unreadable cache', () => {
    source(); setRemote({ 'zshrc.sh': 'local\n' });
    const original = fs.lstatSync; fs.lstatSync = () => { throw new Error('PRIVATE_ERROR'); };
    try { assert.equal(run().status, 0); } finally { fs.lstatSync = original; }
  });
  it('rejects a non-directory cache without repairing it', () => {
    source(); setRemote({ 'zshrc.sh': 'remote\n' }); fs.writeFileSync(cacheRoot, 'PRIVATE_SECRET');
    const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'cache unreadable');
    assert.equal(fs.readFileSync(cacheRoot, 'utf8'), 'PRIVATE_SECRET');
  });
  it('missing remote coverage remains failure when cache diagnosis is inaccessible', () => {
    source(); const original = fs.lstatSync;
    fs.lstatSync = () => { throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'EACCES' }); };
    try { const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'zshrc.sh: missing'); } finally { fs.lstatSync = original; }
  });
  it('rechecks selected file type when it changes after discovery', () => {
    source(); const original = fs.fstatSync;
    const originalOpen = fs.openSync; let target: number | undefined;
    fs.openSync = (file: string, ...args: unknown[]) => { const fd = originalOpen(file, ...args); if (file === path.join(home, '.zshrc')) target = fd; return fd; };
    fs.fstatSync = (fd: number, ...args: unknown[]) => fd === target ? { isFile: () => false } : original(fd, ...args);
    try { const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'source collection'); } finally { fs.fstatSync = original; fs.openSync = originalOpen; }
  });
  it('retains every canonical outcome after an unexpected discovery batch failure', () => {
    options.env!.PATH = 42 as unknown as string;
    const result = run(['--verbose']); assert.equal(result.status, 1); assert.include(result.output, 'Current source discovery is incomplete');
    assert.include(result.output, 'mas: unchecked'); assert.include(result.output, 'zshrc.sh: excluded');
  });
  it('supports selected regular-file symlinks without executing their contents', () => {
    source(); fs.rmSync(path.join(home, '.zshrc')); fs.writeFileSync(path.join(root, 'outside'), 'PRIVATE_SECRET');
    fs.symlinkSync(path.join(root, 'outside'), path.join(home, '.zshrc')); setRemote({ 'zshrc.sh': 'PRIVATE_SECRET\n' });
    assert.equal(run().status, 0);
  });
  it('discovery EACCES is incomplete, not a confirmed absent skip', () => {
    source(); const original = fs.statSync;
    fs.statSync = (file: string, ...args: unknown[]) => { if (file === path.join(home, '.zshrc')) throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'EACCES' }); return original(file, ...args); };
    try { const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'source discovery failed'); } finally { fs.statSync = original; }
  });
  it('refuses available unqualified command collectors before brew prefix discovery', () => {
    const calls = path.join(root, 'unexpected-collector');
    for (const tool of ['brew', 'pipx', 'npm', 'uv', 'pyenv', 'mas', 'code', 'code-insiders']) {
      fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(calls)}, 'called'); process.exitCode = 99;\n`, { mode: 0o700 });
    }
    for (const app of ['Code', 'Code - Insiders']) fs.mkdirSync(path.join(home, 'Library/Application Support', app, 'User'), { recursive: true });
    source(); const result = run(['--verbose']); assert.equal(result.status, 1);
    for (const name of ['bash_completions', 'Brewfile', 'pipx', 'vs_extensions', 'npm_global', 'uv_tools', 'pyenv_versions', 'mas']) assert.include(result.output, `${name}: unchecked`);
    assert.isFalse(fs.existsSync(calls));
  });
  it('does not write or repair Ballin config, cache or source state', () => {
    source(); setRemote({ 'zshrc.sh': 'local\n' }); seedCache('old\n');
    fs.chmodSync(path.join(cache, 'zshrc.sh'), 0o644);
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    for (const method of ['writeFileSync', 'chmodSync', 'mkdirSync', 'renameSync', 'rmSync']) {
      const original = fs[method]; originals.set(method, original);
      fs[method] = (...args: unknown[]) => {
        if (String(args[0]).startsWith(checkout) || String(args[0]) === path.join(home, '.zshrc')) throw new Error('PRIVATE_ERROR');
        return original(...args);
      };
    }
    try { assert.equal(run().status, 0); } finally { for (const [method, original] of originals) fs[method] = original; }
    assert.equal(fs.readFileSync(path.join(cache, 'zshrc.sh'), 'utf8'), 'old\n');
    assert.equal(fs.statSync(path.join(cache, 'zshrc.sh')).mode & 0o777, 0o644);
  });
  it('reports failed preference projection without exposing its values', () => {
    config.update = { cleanup: 'PRIVATE_SECRET' }; writeConfig(); const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'source collection');
  });
  it('reports private temporary cleanup failure and never claims a match', () => {
    source(); setRemote({ 'zshrc.sh': 'local\n' });
    const original = fs.rmSync; const leftovers: string[] = [];
    fs.rmSync = (entry: string, ...args: unknown[]) => {
      if (String(entry).includes('ballin-verify-') && leftovers.length === 0) {
        leftovers.push(entry); throw new Error('PRIVATE_ERROR');
      }
      return original(entry, ...args);
    };
    try { const result = run(); assert.equal(result.status, 1); assert.include(result.output, 'private cleanup failed'); }
    finally { fs.rmSync = original; for (const entry of leftovers) fs.rmSync(entry, { recursive: true, force: true }); }
    assert.lengthOf(leftovers, 1);
  });
  for (const args of [['--verbose', '--verbose'], ['PRIVATE_SECRET'], ['--json'], ['--verbose', 'PRIVATE_SECRET']]) it(`rejects malformed verify arguments (${args.length}) before reads`, () => {
    const result = run(args); assert.equal(result.status, 2); assert.equal(result.output, 'Usage: ballin backup verify [--verbose]\n'); assert.lengthOf(state.requests, 0);
  });
  for (const destination of [null, {}, { id: 'PRIVATE_SECRET' }]) it('rejects missing or invalid destination without API calls', () => {
    (config.backup as Record<string, unknown>).repository = destination; writeConfig(); assert.equal(run().status, 1); assert.lengthOf(state.requests, 0);
  });
  it('rejects malformed consent and absent HOME before discovery', () => {
    (config.backup as Record<string, unknown>).includeSensitive = 'PRIVATE_SECRET'; writeConfig(); assert.equal(run().status, 1);
    (config.backup as Record<string, unknown>).includeSensitive = false; writeConfig(); options.homeDir = ''; assert.equal(run().status, 1); assert.lengthOf(state.requests, 0);
  });
  it('suppresses malformed config details', () => {
    fs.writeFileSync(configPath, 'PRIVATE_SECRET'); assert.equal(run().status, 1);
  });
  for (const [fault, value] of [['auth', true], ['node', { isPrivate: false }], ['tree', { truncated: true }], ['blob', 'unreadable']] as const) it(`fails incomplete repository inspection: ${fault}`, () => {
    state.faults[fault] = value; assert.equal(run().status, 1);
  });
  it('rechecks the selected branch after local capture, without retry', () => {
    let queries = 0; let output = ''; const original = process.stdout.write;
    options.repository!.runCommand = (_command, args, opts) => {
      if (String(opts.input).includes('BallinRepository') && ++queries === 3) commitFixture(state, { ...state.commits[state.head].files, ballin_config: Buffer.from('changed').toString('base64') });
      return requestFixture(state, args, opts);
    };
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof original;
    try { assert.equal(runBackupVerify([], options), 1); } finally { process.stdout.write = original; }
    assert.include(output, 'changed during inspection'); assert.equal(queries, 3);
  });
  it('bounds unexpected final-check failures without printing their exception', () => {
    const repository = require('../commands/backup_repository.ts');
    const original = repository.assertRepositoryCurrent;
    const modulePath = require.resolve('../commands/backup_verify.ts');
    delete require.cache[modulePath];
    repository.assertRepositoryCurrent = () => { throw new Error('PRIVATE_ERROR'); };
    try {
      const fresh = require('../commands/backup_verify.ts').runBackupVerify;
      const result = run([], fresh); assert.equal(result.status, 1); assert.include(result.output, 'final repository check failed');
    } finally { repository.assertRepositoryCurrent = original; delete require.cache[modulePath]; }
  });

  it('covers the shared presence decision table independently of files', () => {
    for (const [base, remote, equal, baseEqual, expected] of [[false,false,false,false,'change'],[false,true,true,false,'match'],[false,true,false,false,'conflict'],[true,false,false,false,'conflict'],[true,true,true,false,'match'],[true,true,false,true,'change'],[true,true,false,false,'conflict']] as const) {
      assert.equal(compareSnapshotState(base, remote, equal, baseEqual).status, expected);
    }
  });

  for (const identity of ['existing', 'missing', 'malformed']) it(`public entry preserves ${identity} analytics identity and coarse behavior`, () => {
    const capture = createAnalyticsCapture(root); const statePath = path.join(root, 'remote.json');
    fs.writeFileSync(statePath, JSON.stringify(state)); installRepositoryFixture(bin, statePath);
    config.analytics = { enabled: 'true' }; writeConfig();
    if (identity === 'missing') fs.rmSync(capture.installIdPath);
    if (identity === 'malformed') fs.writeFileSync(capture.installIdPath, 'PRIVATE_SECRET');
    const before = identity === 'missing' ? undefined : fs.readFileSync(capture.installIdPath);
    const child = spawnSync(process.execPath, [path.join(__dirname, '../bin/ballin'), 'backup', 'verify'], {
      encoding: 'utf8', env: testChildEnvironment({ ...capture.env, HOME: home, PATH: bin, BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout }),
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    if (before) assert.isTrue(fs.readFileSync(capture.installIdPath).equals(before)); else assert.isFalse(fs.existsSync(capture.installIdPath));
    const events = capture.readEvents(); assert.equal(events.length, identity === 'existing' ? 1 : 0);
    if (events.length) { assert.equal(events[0].command, 'ballin backup'); assert.notProperty(events[0], 'event'); }
  });
  it('public malformed args and sender failure preserve the verification exit', () => {
    const capture = createAnalyticsCapture(root); config.analytics = { enabled: 'true' }; writeConfig();
    const child = spawnSync(process.execPath, [path.join(__dirname, '../bin/ballin'), 'backup', 'verify', 'PRIVATE_SECRET'], {
      encoding: 'utf8', env: testChildEnvironment({ ...capture.env, HOME: home, PATH: bin, BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout, BALLIN_TEST_ANALYTICS_MODE: 'throw' }),
    });
    assert.equal(child.status, 2); assert.notInclude(child.stdout + child.stderr, 'PRIVATE_SECRET');
  });
  for (const optOut of ['local', 'environment', 'command']) it(`public entry honors ${optOut} analytics opt-out`, () => {
    const capture = createAnalyticsCapture(root); const statePath = path.join(root, 'remote.json');
    fs.writeFileSync(statePath, JSON.stringify(state)); installRepositoryFixture(bin, statePath);
    config.analytics = { enabled: optOut === 'local' ? 'false' : 'true' }; writeConfig();
    const child = spawnSync(process.execPath, [path.join(__dirname, '../bin/ballin'), 'backup', 'verify'], {
      encoding: 'utf8', env: testChildEnvironment({ ...capture.env, HOME: home, PATH: bin, BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout,
        BALLIN_NO_ANALYTICS: optOut === 'environment' ? '1' : undefined, BALLIN_NO_COMMAND_ANALYTICS: optOut === 'command' ? '1' : undefined }),
    });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.lengthOf(capture.readEvents(), 0);
  });
});
