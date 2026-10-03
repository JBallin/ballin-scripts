const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const helpers = require('../commands/commandHelpers.ts');
const { snapshotDefinitions } = require('../commands/backup_snapshots.ts');
import type { AvailableSnapshotObservation } from '../commands/backup_snapshots.ts';

describe('qualified backup collector boundaries', () => {
  let root: string; let source: AvailableSnapshotObservation;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const versionDescriptor = Object.getOwnPropertyDescriptor(process, 'version')!;
  const originalHash = crypto.createHash;
  const originalRun = helpers.runCommand;
  const reload = () => { delete require.cache[require.resolve('../commands/backup_collectors.ts')]; return require('../commands/backup_collectors.ts'); };
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'version', { value: 'v24.21.0' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-collector-test-'));
    fs.mkdirSync(path.join(root, 'package/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package/bin/npm-cli.js'), 'fixture', { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'package/package.json'), '{}');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync(path.join(root, 'package/bin/npm-cli.js'), path.join(root, 'bin/npm'));
    for (const [name, target] of [['bash', '/bin/bash'], ['ls', '/bin/ls'], ['node', process.execPath]]) fs.symlinkSync(target, path.join(root, 'bin', name));
    const definition = snapshotDefinitions.find((d: { name: string }) => d.name === 'npm_global');
    source = { definition, ...definition.discover({ homeDir: root, env: { HOME: root, PATH: path.join(root, 'bin'), npm_config_prefix: 'real-prefix' } }) };
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.defineProperty(process, 'version', versionDescriptor);
    crypto.createHash = originalHash; helpers.runCommand = originalRun; reload();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const qualifyFixture = () => {
    crypto.createHash = () => ({ update() { return this; }, digest() { return '5b18b54d55d52474a913ee469f117a2010452e42adaefa62c0078d5c2609a5d8'; } });
  };
  it('refuses unqualified artifacts without executing any command', () => {
    helpers.runCommand = () => { throw new Error('Unexpected execution'); };
    assert.isUndefined(reload().captureQualifiedCollector(source));
  });
  it('binds the artifact to all runtime files and rejects symlinks', () => {
    const { artifactDigest } = reload(); const artifact = path.join(root, 'package');
    const original = artifactDigest(artifact);
    fs.writeFileSync(path.join(artifact, 'dependency.js'), 'changed');
    assert.notEqual(artifactDigest(artifact), original);
    fs.symlinkSync(path.join(root, 'outside'), path.join(artifact, 'dependency-link'));
    assert.throws(() => artifactDigest(artifact), 'Unsupported tool artifact');
  });
  it('runs qualified Node directly, preserving roots and capturing only writer stdout', () => {
    qualifyFixture();
    helpers.runCommand = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; stdio: (string | number)[] }) => {
      assert.equal(command, process.execPath); assert.equal(args[0], fs.realpathSync(path.join(root, 'package/bin/npm-cli.js')));
      assert.deepEqual(args.slice(1), ['list', '-g', '--depth=0', '--update-notifier=false', '--timing=false']);
      assert.strictEqual(options.env, source.collector.env); assert.equal(options.env.HOME, root);
      assert.equal(options.env.npm_config_prefix, 'real-prefix'); assert.equal(options.cwd, root);
      fs.writeSync(options.stdio[1], Buffer.from('dummy@1.2.3\n'));
      return { status: 0, signal: null, stdout: 'ignored', stderr: 'PRIVATE_ERROR' };
    };
    assert.equal(reload().captureQualifiedCollector(source).toString(), 'dummy@1.2.3\n');
  });
  it('preserves raw completion-list stdout bytes', () => {
    source.definition = { ...source.definition, name: 'bash_completions' }; source.source = { kind: 'directory', name: 'fixture', path: root };
    const bytes = Buffer.from([0xff, 0xfe, 10]);
    helpers.runCommand = (command: string, args: string[], options: { stdio: (string | number)[] }) => {
      assert.equal(command, '/bin/ls'); assert.deepEqual(args, [root]); fs.writeSync(options.stdio[1], bytes);
      return { status: 0, signal: null, stdout: '', stderr: 'PRIVATE_ERROR' };
    };
    assert.isTrue(reload().captureQualifiedCollector(source).equals(bytes));
  });
  for (const control of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) it(`refuses ${control} startup injection`, () => {
    qualifyFixture(); source.collector.env![control] = 'unsafe';
    helpers.runCommand = () => { throw new Error('Unexpected execution'); };
    assert.isUndefined(reload().captureQualifiedCollector(source));
  });
  for (const control of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'BASH_FUNC_npm%%', 'legacyFunction']) it(`refuses writer shell override ${control} without reading or executing it`, () => {
    qualifyFixture(); source.collector.env![control] = control === 'legacyFunction' ? '() { export npm_config_prefix=/other; }' : 'PRIVATE_OVERRIDE';
    helpers.runCommand = () => { throw new Error('Unexpected execution'); };
    assert.isUndefined(reload().captureQualifiedCollector(source));
  });
  for (const tool of ['bash', 'node', 'ls']) it(`refuses writer PATH override for ${tool}`, () => {
    qualifyFixture();
    if (tool === 'ls') { source.definition = { ...source.definition, name: 'bash_completions' }; source.source = { kind: 'directory', name: 'fixture', path: root }; }
    fs.unlinkSync(path.join(root, 'bin', tool)); fs.writeFileSync(path.join(root, 'bin', tool), '#!/bin/sh\necho PRIVATE_OVERRIDE', { mode: 0o700 });
    helpers.runCommand = () => { throw new Error('Unexpected execution'); };
    assert.isUndefined(reload().captureQualifiedCollector(source));
  });
  it('does not skip empty PATH entries that can shadow npm in the writer cwd', () => {
    qualifyFixture(); source.collector.env!.PATH = `:${source.collector.env!.PATH}`;
    fs.writeFileSync(path.join(root, 'npm'), '#!/bin/sh\necho PRIVATE_OVERRIDE', { mode: 0o700 });
    assert.isUndefined(reload().qualifiedCollector(source));
  });
  it('refuses unknown or missing writer resolution', () => {
    qualifyFixture(); delete source.collector.env!.PATH; assert.isUndefined(reload().qualifiedCollector(source));
    source.collector.env!.PATH = path.join(root, 'empty'); assert.isUndefined(reload().qualifiedCollector(source));
  });
  it('cleans the private directory if collector output open fails', () => {
    qualifyFixture(); const originalOpen = fs.openSync; let directory: string | undefined;
    fs.openSync = (file: string, ...args: unknown[]) => {
      if (String(file).includes('ballin-verify-collector-')) { directory = path.dirname(file); throw new Error('PRIVATE_OPEN_ERROR'); }
      return originalOpen(file, ...args);
    };
    try { assert.throws(() => reload().captureQualifiedCollector(source), 'PRIVATE_OPEN_ERROR'); }
    finally { fs.openSync = originalOpen; }
    assert.isString(directory); assert.isFalse(fs.existsSync(directory));
  });
  it('guards completion startup before native execution', () => {
    source.definition = { ...source.definition, name: 'bash_completions' }; source.source = { kind: 'directory', name: 'fixture', path: root };
    source.collector.env!.LD_AUDIT = 'unsafe'; assert.isUndefined(reload().qualifiedCollector(source)); delete source.collector.env!.LD_AUDIT;
    Object.defineProperty(process, 'platform', { value: 'linux' }); assert.isUndefined(reload().qualifiedCollector(source));
  });
  it('refuses unsupported platforms and runtimes', () => {
    qualifyFixture(); Object.defineProperty(process, 'platform', { value: 'linux' }); assert.isUndefined(reload().qualifiedCollector(source));
    Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'version', { value: 'v24.20.0' }); assert.isUndefined(reload().qualifiedCollector(source));
  });
  it('refuses arbitrary npm wrappers and other collectors', () => {
    qualifyFixture(); fs.unlinkSync(path.join(root, 'bin/npm')); fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh');
    assert.isUndefined(reload().qualifiedCollector(source));
    source.definition = { ...source.definition, name: 'Brewfile' }; assert.isUndefined(reload().qualifiedCollector(source));
  });
  for (const failure of [{ status: 1, signal: null }, { status: 0, signal: 'SIGTERM' }, { status: 0, signal: null, error: new Error('PRIVATE_ERROR') }]) it('makes failed qualification capture incomplete with a safe error', () => {
    qualifyFixture(); helpers.runCommand = () => ({ stdout: 'partial', stderr: 'PRIVATE_ERROR', ...failure });
    assert.throws(() => reload().captureQualifiedCollector(source), 'Qualified collector failed');
  });
});

describe('qualified Homebrew prefix discovery', () => {
  let root: string; let env: NodeJS.ProcessEnv;
  const originalHash = crypto.createHash; const originalRun = helpers.runCommand;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalLstat = fs.lstatSync;
  const hashes = {
    'bin/brew': 'c9a27029eb72dab04f4595041f7670bb03b4cb467297abba817883afb23e0bf3',
    'Library/Homebrew/brew.sh': 'b00ebe84912f4171560be6f3c222477f05b8d1ea8586bd7d80128c10b631caaa',
    'Library/Homebrew/utils/os.sh': 'c83eacf7b72cfffac02b87973622bb5b66f6d6ca6e9d80d27b922e5dc0318fa6',
    'Library/Homebrew/help.sh': 'b794805694d185f3d5832c4833b14e68bd6fca08f22fe158b08be1159260ad70',
    'Library/Homebrew/formula_path.sh': '87c5c6c9e751769c5fa7a208fecb811c18405e52515d7ee7a893b95e0e815212',
  };
  const reload = () => { delete require.cache[require.resolve('../commands/backup_collectors.ts')]; return require('../commands/backup_collectors.ts'); };
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-brew-qualification-test-'));
    for (const [name, hash] of Object.entries(hashes)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, hash); }
    fs.lstatSync = (file: string, ...args: unknown[]) => { if (file === '/etc/homebrew/brew.env') throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return originalLstat(file, ...args); };
    env = { HOME: path.join(root, 'home'), PATH: 'original-path', BASH_ENV: 'never-execute' };
    crypto.createHash = () => ({ value: '', update(bytes: Buffer) { this.value = bytes.toString(); return this; }, digest() { return this.value; } });
    helpers.runCommand = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.equal(command, '/bin/bash'); assert.deepEqual(args.slice(0, 1), ['-p']); assert.equal(args.at(-1), '--prefix');
      assert.equal(options.env.HOME, env.HOME); assert.equal(options.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
      assert.equal(options.env.HOMEBREW_NO_AUTO_UPDATE, '1');
      return { status: 0, signal: null, stdout: `${root}\n`, stderr: 'PRIVATE_ERROR' };
    };
  });
  afterEach(() => { fs.lstatSync = originalLstat; crypto.createHash = originalHash; helpers.runCommand = originalRun; Object.defineProperty(process, 'platform', platformDescriptor); reload(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = () => reload().readQualifiedBrewPrefix(path.join(root, 'bin/brew'), env);
  it('permits only the fingerprinted prefix path with original HOME', () => assert.equal(read(), root));
  it('refuses unsupported platform or missing HOME', () => { Object.defineProperty(process, 'platform', { value: 'linux' }); assert.isUndefined(read()); Object.defineProperty(process, 'platform', { value: 'darwin' }); delete env.HOME; assert.isUndefined(read()); });
  it('refuses unknown source, missing source and non-file source', () => { const file = path.join(root, 'Library/Homebrew/help.sh'); fs.writeFileSync(file, 'changed'); assert.isUndefined(read()); fs.unlinkSync(file); assert.isUndefined(read()); fs.mkdirSync(file); assert.isUndefined(read()); });
  it('refuses an alternate executable symlink layout', () => { fs.renameSync(path.join(root, 'bin/brew'), path.join(root, 'bin/other')); fs.symlinkSync('other', path.join(root, 'bin/brew')); assert.isUndefined(read()); });
  for (const config of ['prefix', 'home', 'xdg', 'brew-xdg']) it(`refuses unqualified ${config} settings without reading them`, () => {
    if (config === 'xdg') env.XDG_CONFIG_HOME = path.join(root, 'xdg');
    if (config === 'brew-xdg') env.HOMEBREW_XDG_CONFIG_HOME = path.join(root, 'xdg');
    const file = config === 'prefix' ? path.join(root, 'etc/homebrew/brew.env') : config === 'home' ? path.join(env.HOME!, '.homebrew/brew.env') : path.join(root, 'xdg/homebrew/brew.env');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'PRIVATE_SETTINGS'); assert.isUndefined(read());
  });
  it('refuses system settings and unreadable applicability', () => {
    fs.lstatSync = (file: string, ...args: unknown[]) => file === '/etc/homebrew/brew.env' ? { isFile: () => true } : originalLstat(file, ...args); assert.isUndefined(read());
    fs.lstatSync = (file: string, ...args: unknown[]) => { if (file === '/etc/homebrew/brew.env') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return originalLstat(file, ...args); }; assert.isUndefined(read());
  });
  it('refuses native loader controls', () => { env.DYLD_INSERT_LIBRARIES = 'unsafe'; assert.isUndefined(read()); });
  for (const result of [{ status: 1, signal: null, stdout: 'PRIVATE_ERROR' }, { status: 0, signal: 'SIGTERM', stdout: 'PRIVATE_ERROR' }, { status: 0, signal: null, stdout: '', error: new Error('PRIVATE_ERROR') }, { status: 0, signal: null, stdout: '' }]) it('reports failed or empty discovery without raw output', () => { helpers.runCommand = () => result; assert.isUndefined(read()); });
});
