const fs = require('fs');
const {
  RepositoryError, readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead,
  createRepositoryBackup, publishRepositorySnapshots, repositoryCacheDirectory, repositoryUrl,
  repositoryReadmeContents,
} = require('../commands/backup_repository.ts');
const { fixtureDestination, fixtureState, commitFixture, requestFixture } = require('./helpers/repository.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { FixtureState } from './helpers/repository.ts';
import type { RepositoryRead, RepositoryOptions } from '../commands/backup_repository.ts';
import type { SpawnSyncOptions } from 'child_process';

describe('private repository transport', () => {
  let state: FixtureState;
  let options: RepositoryOptions;
  const read = (): RepositoryRead => requireRepositoryRead(inspectRepository(fixtureDestination, options));
  const changes = () => new Map([['zshrc.sh', Buffer.from('updated\n')], ['gitconfig', Buffer.from('new\n')]]);
  const publications = () => state.requests.filter((r) => r.payload?.query?.includes('BallinPublish'));
  const run = (_command: string, args: string[], opts: SpawnSyncOptions) => requestFixture(state, args, opts);
  beforeEach(() => {
    state = fixtureState({ 'zshrc.sh': 'original\n' });
    options = { env: testChildEnvironment({ GH_DEBUG: 'api' }), runCommand: run };
  });

  it('uses the effective account, candidate identity, and stable node lookup', () => {
    const account = readRepositoryAccount(options);
    assert.equal(account.id, state.ownerId);
    assert.deepEqual(candidateRepository(state.name, account, options), fixtureDestination);
    assert.equal(repositoryUrl(fixtureDestination, account), 'https://github.com/fixture-user/ballin-backups');
    assert.throws(() => repositoryUrl(fixtureDestination, { id: 'U_other', login: 'other' }), RepositoryError, 'does not match');
    const result = read();
    assert.equal(result.snapshots.get('zshrc.sh')?.toString(), 'original\n');
    assert.isTrue(state.requests.every((request) => request.debug === ''));
    assert.equal(publications().length, 0);
  });
  it('recognizes the real string 404 response without claiming a prior destination was deleted', () => {
    state.exists = false;
    assert.isNull(candidateRepository(state.name, readRepositoryAccount(options), options));
    assert.equal(inspectRepository(fixtureDestination, options).problem, 'unavailable');
    assert.equal(state.requests.filter((r) => r.endpoint === 'user/repos').length, 0);
  });
  it('creates a private repository and initializes only its generated seed through the conditional API', () => {
    state.exists = false;
    const result = createRepositoryBackup(state.name, readRepositoryAccount(options), options);
    assert.deepEqual([...result.snapshots.keys()], ['.ballin-backup.json']);
    assert.deepEqual(
      result.revision.entries.map(({ path }: { path: string }) => path).sort(),
      ['.ballin-backup.json', 'README.md'],
    );
    assert.equal(publications().length, 1);
    const input = publications()[0].payload?.variables?.input as Record<string, unknown>;
    assert.deepEqual(input.message, { headline: 'Initialize Ballin backup' });
    assert.notProperty(input.fileChanges, 'deletions');
    const additions = (input.fileChanges as { additions: { path: string; contents: string }[] }).additions;
    assert.deepEqual(additions.map(({ path }) => path), ['.ballin-backup.json', 'README.md']);
    assert.equal(Buffer.from(additions[1].contents, 'base64').toString(), repositoryReadmeContents);
    assert.include(repositoryReadmeContents, 'selected portable Ballin preferences');
    assert.include(repositoryReadmeContents, 'not a complete copy of the local Ballin configuration');
    assert.include(repositoryReadmeContents, 'current behavior and guidance');
    assert.include(repositoryReadmeContents, 'github.com/JBallin/ballin-scripts/tree/main/docs');
    assert.include(repositoryReadmeContents, '.ballin-backup.json');
    const created = state.requests.find((r) => r.endpoint === 'user/repos');
    assert.deepEqual(created?.payload, { name: state.name, private: true, auto_init: true });
  });
  ['extra-file', 'extra-parent'].forEach((mode) => {
    it(`refuses to initialize a created repository with an unexpected ${mode}`, () => {
      state.exists = false;
      options.runCommand = (command, args, opts) => {
        const result = run(command, args, opts);
        if (args.includes('user/repos')) {
          const files = { ...state.commits[state.head].files };
          if (mode === 'extra-file') files.extra = Buffer.from('retain me').toString('base64');
          commitFixture(state, files, mode === 'extra-file' ? [] : [state.head]);
        }
        return result;
      };
      assert.throws(() => createRepositoryBackup(state.name, readRepositoryAccount(options), options), RepositoryError, 'not a supported');
      assert.equal(publications().length, 0);
    });
  });
  it('publishes exact multi-file bytes in one commit and retains arbitrary and retired flat entries without downloading them', () => {
    state = fixtureState({
      'zshrc.sh': 'original\n', 'README.md': 'User presentation\n',
      'brackets_settings.json': 'retired secret', 'unusual-name': 'unexpected secret',
    });
    const before = read();
    assert.equal(before.snapshots.size, 2);
    assert.isUndefined(before.snapshots.get('README.md'));
    const after = publishRepositorySnapshots(before, changes(), options);
    assert.equal(after.revision.parents[0], before.revision.head);
    assert.equal(after.snapshots.get('gitconfig')?.toString(), 'new\n');
    assert.equal(after.revision.entries.length, 6);
    assert.equal(publications().length, 1);
    const input = publications()[0].payload?.variables?.input as Record<string, unknown>;
    assert.notProperty(input.fileChanges, 'deletions');
    assert.deepEqual(
      (input.fileChanges as { additions: { path: string }[] }).additions.map(({ path }) => path).sort(),
      ['gitconfig', 'zshrc.sh'],
    );
    assert.equal(input.expectedHeadOid, before.revision.head);
    assert.deepEqual(input.branch, { id: 'REF_R_fixture_main' });
    assert.equal(Buffer.from(state.commits[state.head].files['README.md'], 'base64').toString(), 'User presentation\n');
  });
  it('does not publish a true no-op', () => {
    const before = read();
    const after = publishRepositorySnapshots(before, new Map(), options);
    assert.strictEqual(after, before);
    assert.equal(publications().length, 0);
  });
  it('does not require or recreate the non-authoritative README during ordinary reads and no-op backup', () => {
    const files = { ...state.commits[state.head].files };
    delete files['README.md'];
    commitFixture(state, files);
    const before = read();
    assert.equal(before.snapshots.get('zshrc.sh')?.toString(), 'original\n');
    assert.strictEqual(publishRepositorySnapshots(before, new Map(), options), before);
    assert.notInclude(before.revision.entries.map(({ path }) => path), 'README.md');
    assert.equal(publications().length, 0);
  });
  it('preserves exact large and binary bytes rather than normalizing remote content', () => {
    const before = read();
    const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 + 3, 255), Buffer.from('\r\n\n')]);
    const result = publishRepositorySnapshots(before, new Map([['zshrc.sh', bytes]]), options);
    assert.isTrue(result.snapshots.get('zshrc.sh').equals(bytes));
  });
  it('confirms ambiguous server-side success without another mutation', () => {
    const before = read();
    state.faults.publish = 'ambiguous';
    const after = publishRepositorySnapshots(before, changes(), options);
    assert.notEqual(after.revision.head, before.revision.head);
    assert.equal(publications().length, 1);
  });
  ['advance', 'rewind', 'reject', 'denied'].forEach((mode) => {
    it(`refuses ${mode} publication without forcing or retrying`, () => {
      if (mode === 'rewind') commitFixture(state, { ...state.commits[state.head].files, gitconfig: Buffer.from('before\n').toString('base64') });
      const before = read();
      state.faults.publish = mode;
      assert.throws(() => publishRepositorySnapshots(before, changes(), options), RepositoryError, 'rejected');
      assert.equal(publications().length, 1);
    });
  });
  ['orphan', 'wrong-readback'].forEach((mode) => {
    it(`does not promote ${mode} objects to a confirmed outcome`, () => {
      const before = read();
      state.faults.publish = mode;
      assert.throws(() => publishRepositorySnapshots(before, changes(), options), RepositoryError, 'unconfirmed');
      assert.equal(publications().length, 1);
    });
  });
  it('requires returned revision equality and validates publication input names', () => {
    const before = read();
    assert.throws(() => publishRepositorySnapshots(before, new Map([['nested/zshrc.sh', Buffer.from('x')]]), options), RepositoryError);
    state.faults.returnedCommit = '0'.repeat(40);
    assert.throws(() => publishRepositorySnapshots(before, changes(), options), RepositoryError, 'unconfirmed');
  });
  it('refuses a changed head before publication and retains inspected-revision facts on movement during a read', () => {
    const before = read();
    commitFixture(state, { ...state.commits[state.head].files, gitconfig: Buffer.from('external\n').toString('base64') });
    assert.throws(() => publishRepositorySnapshots(before, changes(), options), RepositoryError, 'changed during inspection');
    assert.equal(publications().length, 0);
    let queries = 0;
    options.runCommand = (_command, args, opts) => {
      if (String(opts.input).includes('BallinRepository') && ++queries === 2) {
        commitFixture(state, { ...state.commits[state.head].files, gitconfig: Buffer.from('second\n').toString('base64') });
      }
      return requestFixture(state, args, opts);
    };
    const inspection = inspectRepository(fixtureDestination, options);
    assert.equal(inspection.status, 'incomplete');
    assert.equal(inspection.problem, 'moved');
    assert.equal(inspection.inspected.snapshots.get('gitconfig').toString(), 'external\n');
  });
  it('keeps stable identity and cache scope across repository and account renames', () => {
    state.name = 'renamed'; state.login = 'renamed-user';
    const result = read();
    assert.equal(result.destination.name, 'renamed');
    const cache = repositoryCacheDirectory('/fixture/cache', fixtureDestination);
    assert.equal(cache, repositoryCacheDirectory('/fixture/cache', result.destination));
    ['id', 'ownerId', 'branch'].forEach((key) => assert.notEqual(cache, repositoryCacheDirectory('/fixture/cache', { ...fixtureDestination, [key]: 'different' })));
  });
  const invalidNodes = [
    { id: 'R_wrong' }, { name: '../wrong' }, { isPrivate: false }, { isFork: true }, { isArchived: true }, { isDisabled: true },
    { owner: { id: 'U_wrong', __typename: 'User' } }, { owner: { id: 'U_fixture', __typename: 'Organization' } },
    { owner: { id: 'U_fixture', __typename: 'User', login: 'different' } }, { ref: null },
    { ref: { name: 'wrong', target: {} } },
    { ref: { name: 'main', target: { __typename: 'Tree' } } },
    { ref: { name: 'main', target: { __typename: 'Commit', parents: { nodes: [], pageInfo: { hasNextPage: true } } } } },
  ];
  invalidNodes.forEach((node, index) => it(`fails closed on unsupported or mismatched repository metadata ${index}`, () => {
    state.faults.node = node;
    assert.equal(inspectRepository(fixtureDestination, options).status, 'incomplete');
    assert.equal(publications().length, 0);
  }));
  [null, false, '', 'unsafe value'].forEach((nodeId) => it(`rejects malformed account identity ${JSON.stringify(nodeId)}`, () => {
    state.faults.user = { type: 'User', login: 'fixture-user', node_id: nodeId };
    assert.throws(() => readRepositoryAccount(options), RepositoryError);
  }));
  [{ type: 'Bot' }, { type: 'User', login: 'bad/path' }].forEach((user) => it('rejects unsupported effective accounts', () => {
    state.faults.user = user;
    assert.throws(() => readRepositoryAccount(options), RepositoryError);
  }));
  const faults = [
    { auth: true }, { query: 'errors' }, { query: 'missing' }, { tree: 'unreadable' },
    { tree: { truncated: true } }, { tree: { tree: {} } }, { tree: { sha: 'bad' } },
    { tree: { tree: [null] } }, { tree: { tree: [{ path: '' }] } },
    { blob: 'unreadable' }, { blob: { sha: 'bad' } }, { blob: { size: -1 } },
    { blob: { truncated: true } }, { blob: { encoding: 'utf-8' } }, { blob: { content: 'not base64!' } },
    { blob: { content: Buffer.from('same size edit').toString('base64') } },
  ];
  faults.forEach((fault, index) => it(`rejects incomplete identity/inventory/content evidence ${index}`, () => {
    state.faults = fault;
    const result = inspectRepository(fixtureDestination, options);
    assert.equal(result.status, 'incomplete');
    assert.throws(() => requireRepositoryRead(result), RepositoryError);
  }));
  ['directory/zshrc.sh', '.github/workflows/test.yml', '..', '.', 'bad\\name', 'bad\u001bname'].forEach((name) => it(`rejects unsupported path ${JSON.stringify(name)}`, () => {
    state.faults.tree = { tree: [{ path: name, mode: '100644', type: 'blob', size: 0, sha: '0'.repeat(40) }] };
    assert.equal(inspectRepository(fixtureDestination, options).problem, 'unsupported');
  }));
  ['100755', '120000', '160000', '040000'].forEach((mode) => it(`rejects unsupported mode ${mode}`, () => {
    state.faults.tree = { tree: [{ path: 'zshrc.sh', mode, type: 'blob', size: 0, sha: '0'.repeat(40) }] };
    assert.equal(inspectRepository(fixtureDestination, options).problem, 'unsupported');
  }));
  it('rejects duplicate paths, bad sizes/object IDs, and a copied or missing marker', () => {
    const entry = { path: 'zshrc.sh', mode: '100644', type: 'blob', size: 0, sha: '0'.repeat(40) };
    for (const entries of [[entry, entry], [{ ...entry, size: NaN }], [{ ...entry, sha: 'bad' }]]) {
      state.faults.tree = { tree: entries };
      assert.equal(inspectRepository(fixtureDestination, options).status, 'incomplete');
    }
    state.faults = {};
    for (const files of [{}, { '.ballin-backup.json': Buffer.from('copied marker').toString('base64') }]) {
      commitFixture(state, files);
      assert.equal(inspectRepository(fixtureDestination, options).problem, 'unsupported');
    }
  });
  ['reject', 'ambiguous'].forEach((mode) => it(`does not repeat ${mode} repository creation`, () => {
    state.exists = false; state.faults.create = mode;
    assert.throws(() => createRepositoryBackup(state.name, readRepositoryAccount(options), options), RepositoryError);
    assert.equal(state.requests.filter((r) => r.endpoint === 'user/repos').length, 1);
  }));
  it('rejects invalid candidates and handles candidate access/owner failures', () => {
    const account = readRepositoryAccount(options);
    assert.throws(() => candidateRepository('../bad', account, options), RepositoryError);
    assert.throws(() => createRepositoryBackup('../bad', account, options), RepositoryError);
    state.faults.candidate = 'denied';
    assert.throws(() => candidateRepository(state.name, account, options), RepositoryError);
    state.faults = { candidateMetadata: { owner: { type: 'Organization' } } };
    assert.throws(() => candidateRepository(state.name, account, options), RepositoryError);
  });
  it('sanitizes malformed transport output and spawn/storage failures', () => {
    options.runCommand = () => ({ status: 0, stdout: 'dummy-sensitive-text' });
    assert.throws(() => readRepositoryAccount(options), RepositoryError, 'invalid');
    options.runCommand = () => ({ status: 1, error: new Error('dummy-secret') });
    assert.throws(() => readRepositoryAccount(options), RepositoryError, 'authentication');
    const original = fs.openSync;
    try {
      fs.openSync = () => { throw new Error('local secret'); };
      assert.throws(() => readRepositoryAccount(options), RepositoryError, 'private backup transport');
    } finally { fs.openSync = original; }
  });
});
