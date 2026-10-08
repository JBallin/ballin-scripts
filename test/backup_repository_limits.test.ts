const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RepositoryError, inspectRepository, requireRepositoryRead, readRepositorySnapshot,
  readRepositoryInventory, repositoryOpenUrl, inspectRepositoryMaintenance, publishRepositorySnapshots,
  readRepositoryAccount, repositorySnapshotByteLimit, repositorySnapshotSetByteLimit, requireRepositorySnapshotSizes,
} = require('../commands/backup_repository.ts');
const { fixtureDestination, fixtureState, requestFixture, blobHash } = require('./helpers/repository.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { FixtureState } from './helpers/repository.ts';
import type { RepositoryOptions } from '../commands/backup_repository.ts';

describe('repository backup resource limits', function() {
  this.timeout(15000);
  let state: FixtureState;
  let options: RepositoryOptions;
  const read = () => requireRepositoryRead(inspectRepository(fixtureDestination, options));
  const blobs = () => state.requests.filter((r) => r.endpoint.includes('/git/blobs/'));
  const publications = () => state.requests.filter((r) => r.payload?.query?.includes('BallinPublish'));
  const sizes = (values: Record<string, number>): void => {
    delete state.faults.tree;
    const tree = state.commits[state.head].tree;
    const response = JSON.parse(requestFixture(state, ['api', '--hostname', 'github.com', '--method', 'GET',
      `repos/${state.login}/${state.name}/git/trees/${tree}?recursive=1`]).stdout);
    response.tree.forEach((entry: { path: string; size: number }) => {
      if (values[entry.path] !== undefined) entry.size = values[entry.path];
    });
    state.faults.tree = response;
    state.requests = [];
  };
  beforeEach(() => {
    state = fixtureState({ 'zshrc.sh': 'original\n', gitconfig: 'git\n', vimrc: 'vim\n' });
    options = { env: testChildEnvironment(), runCommand: (_command, args, opts) => requestFixture(state, args, opts) };
  });

  it('accepts inclusive stored-byte boundaries and rejects overflow and invalid sizes', () => {
    assert.equal(repositorySnapshotByteLimit, 32 * 1024 * 1024);
    assert.equal(repositorySnapshotSetByteLimit, 64 * 1024 * 1024);
    assert.doesNotThrow(() => requireRepositorySnapshotSizes([repositorySnapshotByteLimit, repositorySnapshotByteLimit]));
    for (const values of [[repositorySnapshotByteLimit + 1], [repositorySnapshotByteLimit, repositorySnapshotByteLimit, 1]]) {
      assert.throws(() => requireRepositorySnapshotSizes(values), RepositoryError, 'normal CLI limits');
    }
    for (const value of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => requireRepositorySnapshotSizes([value]), RepositoryError, 'invalid backup metadata');
    }
  });
  it('refuses an oversized blob after the marker and before downloading canonical content', () => {
    sizes({ 'zshrc.sh': repositorySnapshotByteLimit + 1 });
    assert.throws(read, RepositoryError, 'normal CLI limits');
    assert.lengthOf(blobs(), 1); assert.lengthOf(publications(), 0);
  });
  it('preflights the whole current set before hydrating any canonical snapshots', () => {
    sizes({ 'zshrc.sh': repositorySnapshotByteLimit, gitconfig: repositorySnapshotByteLimit, vimrc: 1 });
    assert.throws(read, RepositoryError, 'normal CLI limits');
    assert.lengthOf(blobs(), 1);
  });
  for (const mode of ['inventory', 'open', 'maintenance', 'small-selected']) {
    it(`preserves validated ${mode} access despite oversized unrequested contents`, () => {
      sizes({ 'zshrc.sh': repositorySnapshotByteLimit + 1 });
      if (mode === 'inventory') assert.lengthOf(readRepositoryInventory(fixtureDestination, options).entries, 5);
      else if (mode === 'open') assert.equal(repositoryOpenUrl(fixtureDestination, options), 'https://github.com/fixture-user/ballin-backups');
      else if (mode === 'maintenance') assert.deepEqual(inspectRepositoryMaintenance(fixtureDestination, options).destination, fixtureDestination);
      else assert.equal(readRepositorySnapshot(fixtureDestination, 'gitconfig', options)?.toString(), 'git\n');
      assert.lengthOf(blobs(), mode === 'small-selected' ? 2 : 1);
      assert.lengthOf(publications(), 0);
    });
  }
  it('rejects oversized selected reads and retains excluded noncanonical entries', () => {
    sizes({ 'zshrc.sh': repositorySnapshotByteLimit + 1, 'README.md': Number.MAX_SAFE_INTEGER });
    assert.throws(() => readRepositorySnapshot(fixtureDestination, 'zshrc.sh', options), RepositoryError, 'normal CLI limits');
    sizes({ 'README.md': Number.MAX_SAFE_INTEGER });
    assert.equal(read().snapshots.get('zshrc.sh')?.toString(), 'original\n');
  });
  it('accepts and integrity-checks a real exactly 32 MiB stored blob', () => {
    const bytes = Buffer.alloc(repositorySnapshotByteLimit, 120), content = bytes.toString('base64'), sha = blobHash(content);
    sizes({ 'zshrc.sh': bytes.length });
    const tree = state.faults.tree as { tree: { path: string; sha: string }[] };
    tree.tree.find((entry) => entry.path === 'zshrc.sh')!.sha = sha;
    options.runCommand = (_command, args, opts) => args[5].endsWith(`/git/blobs/${sha}`)
      ? { status: 0, signal: null, stdout: JSON.stringify({ sha, size: bytes.length, content, encoding: 'base64' }) }
      : requestFixture(state, args, opts);
    assert.isTrue(readRepositorySnapshot(fixtureDestination, 'zshrc.sh', options)!.equals(bytes));
  });
  it('rejects an inflated encoded response despite a small declared blob size', () => {
    const sha = blobHash(state.commits[state.head].files['zshrc.sh']);
    options.runCommand = (_command, args, opts) => args[5].endsWith(`/git/blobs/${sha}`)
      ? { status: 0, signal: null, stdout: JSON.stringify({ sha, size: 9, content: '\n'.repeat(70 * 1024), encoding: 'base64' }) }
      : requestFixture(state, args, opts);
    assert.throws(read, RepositoryError, 'normal CLI limits');
  });
  it('rejects a wrong encoded length before decoding and retains CRLF base64 support', () => {
    const sha = blobHash(state.commits[state.head].files['zshrc.sh']);
    const original = options.runCommand!;
    for (const content of ['eA==', 'eHh4eHh4eHh4eHh4']) {
      options.runCommand = (command, args, opts) => args[5].endsWith(`/git/blobs/${sha}`)
        ? { status: 0, signal: null, stdout: JSON.stringify({ sha, size: 9, content, encoding: 'base64' }) }
        : original(command, args, opts);
      assert.throws(read, RepositoryError, 'invalid backup metadata');
    }
    options.runCommand = (command, args, opts) => {
      const result = original(command, args, opts);
      if (args[5].includes('/git/blobs/')) {
        const body = JSON.parse(result.stdout!); body.content = `${body.content}\r\n`; result.stdout = JSON.stringify(body);
      }
      return result;
    };
    assert.equal(read().snapshots.get('zshrc.sh')?.toString(), 'original\n');
  });
  for (const kind of ['stdout', 'stderr', 'combined', 'native-overflow']) {
    it(`sanitizes ${kind} transport overflow before parsing`, () => {
      options.runCommand = () => kind === 'native-overflow'
        ? { status: null, error: Object.assign(new Error('DUMMY_PRIVATE_ERROR'), { code: 'ENOBUFS' }), stdout: 'not JSON' }
        : { status: 0, stdout: kind === 'stderr' ? '{}' : 'x'.repeat(kind === 'combined' ? 600_000 : 1_100_000),
          stderr: kind === 'stdout' ? '' : 'DUMMY_PRIVATE_ERROR'.repeat(kind === 'combined' ? 30_000 : 60_000) };
      assert.throws(() => readRepositoryAccount(options), RepositoryError, 'normal CLI limits');
      assert.notInclude(String(inspectRepository(fixtureDestination, options).problem), 'DUMMY_PRIVATE_ERROR');
    });
  }
  it('passes bounded pipes, deadline and forced termination through the existing runner', () => {
    options.runCommand = (_command, args, opts) => {
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(opts.maxBuffer, 1024 * 1024); assert.equal(opts.timeout, 30000); assert.equal(opts.killSignal, 'SIGKILL');
      return requestFixture(state, args, opts);
    };
    assert.equal(readRepositoryAccount(options).id, state.ownerId);
  });
  it('allows a bounded slow snapshot transfer without retrying publication', () => {
    const before = read(), bytes = Buffer.alloc(3 * 1024 * 1024, 120);
    const original = options.runCommand!;
    options.runCommand = (command, args, opts) => {
      const result = original(command, args, opts);
      const wireBytes = Buffer.byteLength(String(opts.input ?? '')) + Buffer.byteLength(result.stdout ?? '');
      // Advance a virtual 128 KiB/s transfer with five seconds of connection overhead.
      const elapsedMs = 5000 + Math.ceil(wireBytes / (128 * 1024) * 1000);
      assert.isAtMost(opts.timeout ?? 0, 15 * 60 * 1000);
      return elapsedMs > (opts.timeout ?? 0)
        ? { ...result, status: null, signal: 'SIGKILL',
          error: Object.assign(new Error('DUMMY_PRIVATE_TIMEOUT'), { code: 'ETIMEDOUT' }) }
        : result;
    };
    const after = publishRepositorySnapshots(before, new Map([['zshrc.sh', bytes]]), options);
    assert.isTrue(after.snapshots.get('zshrc.sh')!.equals(bytes));
    assert.lengthOf(publications(), 1);
  });
  it('terminates a real isolated fake gh producing excessive output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-repository-output-test-'));
    try {
      fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024));\n`, { mode: 0o755 });
      assert.throws(() => readRepositoryAccount({ env: testChildEnvironment({ HOME: root, PATH: root }) }), RepositoryError, 'normal CLI limits');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds tree responses and rejects excessive tree entry count before mapping', () => {
    state.faults.tree = { tree: Array(100_001).fill(null) };
    assert.throws(read, RepositoryError, 'normal CLI limits');
    state.faults.tree = { tree: [], padding: 'x'.repeat(8 * 1024 * 1024) };
    assert.throws(read, RepositoryError, 'normal CLI limits');
  });
  it('counts retained current sizes before publication, replacing old contributions', () => {
    const before = read();
    for (const entry of before.revision.entries) if (['zshrc.sh', 'gitconfig'].includes(entry.path)) entry.size = repositorySnapshotByteLimit;
    assert.throws(() => publishRepositorySnapshots(before, new Map([['vimrc', Buffer.from('new\n')]]), options), RepositoryError, 'normal CLI limits');
    assert.lengthOf(publications(), 0);
    const after = publishRepositorySnapshots(before, new Map([['zshrc.sh', Buffer.from('new\n')]]), options);
    assert.equal(after.snapshots.get('zshrc.sh')?.toString(), 'new\n'); assert.lengthOf(publications(), 1);
  });
  it('refuses oversized additions before hashing, encoding or contacting GitHub', () => {
    const before = read(), count = state.requests.length;
    assert.throws(() => publishRepositorySnapshots(before, new Map([['zshrc.sh', Buffer.alloc(repositorySnapshotByteLimit + 1)]]), options), RepositoryError, 'normal CLI limits');
    assert.lengthOf(state.requests, count); assert.lengthOf(publications(), 0);
  });
  it('retains a confirmed remote effect after publication output overflow without retrying', () => {
    const before = read(), original = options.runCommand!;
    options.runCommand = (command, args, opts) => {
      const result = original(command, args, opts);
      return opts.input && String(opts.input).includes('mutation BallinPublish')
        ? { ...result, stdout: 'x'.repeat(1_100_000) } : result;
    };
    assert.throws(() => publishRepositorySnapshots(before, new Map([['zshrc.sh', Buffer.from('new\n')]]), options), RepositoryError, 'normal CLI limits');
    assert.lengthOf(publications(), 1);
    assert.equal(Buffer.from(state.commits[state.head].files['zshrc.sh'], 'base64').toString(), 'new\n');
  });
});
