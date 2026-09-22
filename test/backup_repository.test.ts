const fs = require('fs');
const {
  RepositoryError, readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead,
  createRepositoryBackup, ensureManagedBranchRuleset, publishRepositorySnapshots,
  repositoryCacheDirectory, repositoryUrl, repositoryReadmeContents, managedBranchRulesetName,
} = require('../commands/backup_repository.ts');
const { fixtureDestination, fixtureRuleset, fixtureState, commitFixture, requestFixture } = require('./helpers/repository.ts');
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
  const rulesetRequests = () => state.requests.filter((r) => r.endpoint.includes('/rulesets'));
  const rulesetWrites = () => rulesetRequests().filter((r) => r.method === 'POST');
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
  it('creates a private repository and initializes the marker and Ballin README in one conditional commit', () => {
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
    assert.include(repositoryReadmeContents, 'to store snapshots of your development environment');
    assert.include(repositoryReadmeContents, 'portable between installations');
    assert.include(repositoryReadmeContents, 'not a complete copy of your local Ballin configuration');
    assert.include(repositoryReadmeContents, 'current backup behavior and guidance');
    assert.include(repositoryReadmeContents, 'github.com/JBallin/ballin-scripts/tree/main/docs');
    assert.include(repositoryReadmeContents, 'uses `.ballin-backup.json` to identify this repository');
    const created = state.requests.find((r) => r.endpoint === 'user/repos');
    assert.deepEqual(created?.payload, { name: state.name, private: true, auto_init: true });
  });
  it('creates the exact minimal managed-branch ruleset and verifies the returned resource independently', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'enabled' });
    assert.equal(rulesetWrites().length, 1);
    assert.deepEqual(rulesetWrites()[0].payload, {
      name: managedBranchRulesetName,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    });
    assert.deepEqual(rulesetRequests().map(({ method, endpoint }) => ({ method, endpoint })), [
      { method: 'GET', endpoint: 'repos/fixture-user/ballin-backups/rulesets?includes_parents=false&targets=branch&per_page=100' },
      { method: 'POST', endpoint: 'repos/fixture-user/ballin-backups/rulesets' },
      { method: 'GET', endpoint: 'repos/fixture-user/ballin-backups/rulesets/2?includes_parents=false' },
    ]);
  });
  it('accepts exact protection without an administration write', () => {
    const before = read(); state.requests = [];
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'present' });
    assert.equal(rulesetWrites().length, 0);
    assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'GET']);
  });
  it('does not claim exact protection when read visibility omits bypass actors', () => {
    const before = read(); state.requests = []; state.faults.rulesetDetail = 'omit-bypass';
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'permission-denied' });
    assert.equal(rulesetWrites().length, 0);
  });
  it('matches owned ruleset invariants semantically instead of requiring raw response equality', () => {
    const before = read(); state.requests = [];
    state.rulesets = [fixtureRuleset({
      source: 'FIXTURE-USER/BALLIN-BACKUPS',
      conditions: { ref_name: { exclude: [], include: ['refs/heads/main', 'refs/heads/main'], metadata: {} }, repository_name: {} },
      rules: [{ type: 'non_fast_forward', parameters: {} }, { type: 'deletion', updated_at: 'response metadata' }],
      response_only: 'ignored',
    })];
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'present' });
    assert.equal(rulesetWrites().length, 0);
  });
  [
    { target: 'tag' },
    { enforcement: 'disabled' },
    { bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] },
    { conditions: { ref_name: { include: ['refs/heads/other'], exclude: [] } } },
    { conditions: { ref_name: { include: ['refs/heads/main'], exclude: ['refs/heads/release'] } } },
    { conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] }, repository_name: { include: ['other'] } } },
    { rules: [{ type: 'deletion' }] },
    { rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request' }] },
    { rules: [{ type: 'deletion', parameters: { protected_file_patterns: ['*'] } }, { type: 'non_fast_forward' }] },
    { rules: [{ type: 'deletion' }, { type: 'pull_request' }] },
    { rules: [{ type: null }, { type: 'non_fast_forward' }] },
    { source_type: 'Organization' },
    { conditions: null },
  ].forEach((override, index) => {
    it(`leaves mismatched named branch protection unchanged ${index + 1}`, () => {
      const before = read(); state.requests = []; state.rulesets = [fixtureRuleset(override)];
      assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'ambiguous', reason: 'mismatch' });
      assert.equal(rulesetWrites().length, 0);
    });
  });
  it('leaves named protection for another repository source unchanged', () => {
    const before = read(); state.requests = []; state.faults.rulesetDetail = 'wrong-source';
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'ambiguous', reason: 'mismatch' });
    assert.equal(rulesetWrites().length, 0);
  });
  it('leaves duplicate named rulesets unchanged and creates alongside an unrelated ruleset only', () => {
    const before = read(); state.requests = [];
    state.rulesets = [fixtureRuleset(), fixtureRuleset({ id: 2 })];
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'ambiguous', reason: 'duplicate' });
    assert.equal(rulesetWrites().length, 0);
    state.requests = []; state.rulesets = [fixtureRuleset({ name: 'Unrelated policy' })]; state.nextRulesetId = 2;
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'enabled' });
    assert.equal(rulesetWrites().length, 1);
    assert.deepEqual(state.rulesets.map(({ name }) => name), ['Unrelated policy', managedBranchRulesetName]);
  });
  [
    { mode: 'denied', outcome: { status: 'permission-denied' } },
    { mode: 'server', outcome: { status: 'ambiguous' } },
    { mode: 'malformed', outcome: { status: 'ambiguous' } },
    { mode: 'object', outcome: { status: 'ambiguous' } },
    { mode: 'invalid-id', outcome: { status: 'ambiguous' } },
    { mode: 'invalid-name', outcome: { status: 'ambiguous' } },
  ].forEach(({ mode, outcome }) => {
    it(`classifies ${mode} ruleset-list evidence without writing`, () => {
      const before = read(); state.requests = []; state.faults.rulesetList = mode;
      const result = ensureManagedBranchRuleset(before, options);
      assert.equal(result.status, outcome.status);
      assert.equal(rulesetWrites().length, 0);
    });
  });
  [
    { mode: 'denied', status: 'permission-denied' },
    { mode: 'server', status: 'ambiguous' },
    { mode: 'malformed', status: 'ambiguous' },
    { mode: 'missing', status: 'ambiguous' },
  ].forEach(({ mode, status }) => {
    it(`classifies ${mode} ruleset-detail evidence without writing`, () => {
      const before = read(); state.requests = []; state.faults.rulesetDetail = mode;
      assert.equal(ensureManagedBranchRuleset(before, options).status, status);
      assert.equal(rulesetWrites().length, 0);
    });
  });
  it('refuses protection when the effective account changes after repository inspection', () => {
    const before = read(); state.requests = [];
    before.destination = { ...before.destination, ownerId: 'U_previous' };
    assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'does not match');
    assert.equal(rulesetRequests().length, 0);
  });
  [
    { mode: 'plan', status: 'unsupported' },
    { mode: 'plan-live-shape', status: 'unsupported' },
    { mode: 'plan-alternate', status: 'unsupported' },
    { mode: 'plan-private-first', status: 'unsupported' },
    { mode: 'plan-public-alternative', status: 'unsupported' },
    { mode: 'denied', status: 'permission-denied' },
    { mode: 'admin-required', status: 'permission-denied' },
    { mode: 'permission-missing', status: 'permission-denied' },
    { mode: 'forbidden', status: 'permission-denied' },
    { mode: 'status-only-forbidden', status: 'ambiguous' },
    { mode: 'status-only-missing', status: 'ambiguous' },
    { mode: 'reject', status: 'unexpected' },
    { mode: 'generic-reject', status: 'unexpected' },
    { mode: 'server', status: 'ambiguous' },
    { mode: 'rate-limit', status: 'ambiguous' },
    { mode: 'spam', status: 'ambiguous' },
    { mode: 'ambiguous-no-effect', status: 'ambiguous' },
    { mode: 'no-effect', status: 'ambiguous' },
  ].forEach(({ mode, status }) => {
    it(`classifies ${mode} protection creation without retrying`, () => {
      const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetCreate = mode;
      assert.equal(ensureManagedBranchRuleset(before, options).status, status);
      assert.equal(rulesetWrites().length, 1);
      if (['plan', 'plan-live-shape', 'plan-alternate', 'plan-private-first', 'plan-public-alternative',
        'denied', 'admin-required', 'permission-missing', 'forbidden', 'reject', 'generic-reject'].includes(mode)) {
        assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'POST']);
      }
    });
  });
  ['ambiguous', 'malformed', 'server-applied', 'missing-id-applied'].forEach((mode) => {
    it(`reconciles ${mode} protection creation without repeating the mutation`, () => {
      const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetCreate = mode;
      assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'enabled' });
      assert.equal(rulesetWrites().length, 1);
      assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'POST', 'GET', 'GET']);
    });
  });
  it('reconciles after the created ruleset detail is transiently unavailable', () => {
    const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetDetail = 'server-once';
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'enabled' });
    assert.equal(rulesetWrites().length, 1);
    assert.deepEqual(rulesetRequests().map(({ method }) => method), ['GET', 'POST', 'GET', 'GET', 'GET']);
  });
  it('preserves a local creation transport failure when reconciliation proves no ruleset', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    let attempts = 0;
    options.runCommand = (command, args, opts) => {
      if (args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST'
        && args[args.indexOf('--method') + 2].endsWith('/rulesets')) {
        attempts += 1;
        throw new Error('dummy local failure');
      }
      return run(command, args, opts);
    };
    assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'private backup transport');
    assert.equal(attempts, 1);
  });
  it('preserves a local detail transport failure after reconciliation confirms the created ruleset', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    let failed = false;
    options.runCommand = (command, args, opts) => {
      const endpoint = args[args.indexOf('--method') + 2];
      if (!failed && args.includes('--method') && args[args.indexOf('--method') + 1] === 'GET'
        && /\/rulesets\/\d+\?/u.test(endpoint)) {
        failed = true;
        throw new Error('dummy local failure');
      }
      return run(command, args, opts);
    };
    assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'private backup transport');
    assert.equal(rulesetWrites().length, 1); assert.lengthOf(state.rulesets, 1);
  });
  it('fails after confirmed ambiguous creation when its private response cleanup is incomplete', () => {
    const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetCreate = 'ambiguous';
    const original = fs.rmSync;
    let retained: string | undefined;
    try {
      fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
        const [entry] = args;
        const request = state.requests.at(-1);
        if (!retained && request?.method === 'POST' && request.endpoint.endsWith('/rulesets')) {
          retained = String(entry);
          throw new Error('dummy cleanup failure');
        }
        return original(...args);
      };
      assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'cleanup is incomplete');
    } finally {
      fs.rmSync = original;
      if (retained) original(retained, { recursive: true, force: true });
    }
    assert.equal(rulesetWrites().length, 1);
    assert.lengthOf(state.rulesets, 1);
  });
  it('fails after directly verified creation when its private response cleanup is incomplete', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    const original = fs.rmSync;
    let retained: string | undefined;
    try {
      fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
        const [entry] = args;
        const request = state.requests.at(-1);
        if (!retained && request?.method === 'POST' && request.endpoint.endsWith('/rulesets')) {
          retained = String(entry);
          throw new Error('dummy cleanup failure');
        }
        return original(...args);
      };
      assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'cleanup is incomplete');
    } finally {
      fs.rmSync = original;
      if (retained) original(retained, { recursive: true, force: true });
    }
    assert.equal(rulesetWrites().length, 1);
    assert.lengthOf(state.rulesets, 1);
  });
  it('preserves malformed-response cleanup failure after reconciliation confirms creation', () => {
    const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetCreate = 'malformed';
    const original = fs.rmSync;
    let retained: string | undefined;
    try {
      fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
        const [entry] = args;
        const request = state.requests.at(-1);
        if (!retained && request?.method === 'POST' && request.endpoint.endsWith('/rulesets')) {
          retained = String(entry);
          throw new Error('dummy cleanup failure');
        }
        return original(...args);
      };
      assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'cleanup is incomplete');
    } finally {
      fs.rmSync = original;
      if (retained) original(retained, { recursive: true, force: true });
    }
    assert.equal(rulesetWrites().length, 1);
    assert.lengthOf(state.rulesets, 1);
  });
  it('preserves created-ruleset detail cleanup failure after reconciliation confirms protection', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    const original = fs.rmSync;
    let retained: string | undefined;
    try {
      fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
        const [entry] = args;
        const request = state.requests.at(-1);
        if (!retained && request?.method === 'GET' && /\/rulesets\/\d+\?/u.test(request.endpoint)) {
          retained = String(entry);
          throw new Error('dummy cleanup failure');
        }
        return original(...args);
      };
      assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'cleanup is incomplete');
    } finally {
      fs.rmSync = original;
      if (retained) original(retained, { recursive: true, force: true });
    }
    assert.equal(rulesetWrites().length, 1);
    assert.lengthOf(state.rulesets, 1);
  });
  it('preserves failed detail-response cleanup after reconciliation confirms protection', () => {
    const before = read(); state.requests = []; state.rulesets = []; state.faults.rulesetDetail = 'server-once';
    const original = fs.rmSync;
    let retained: string | undefined;
    try {
      fs.rmSync = (...args: Parameters<typeof fs.rmSync>) => {
        const [entry] = args;
        const request = state.requests.at(-1);
        if (!retained && request?.method === 'GET' && /\/rulesets\/\d+\?/u.test(request.endpoint)) {
          retained = String(entry);
          throw new Error('dummy cleanup failure');
        }
        return original(...args);
      };
      assert.throws(() => ensureManagedBranchRuleset(before, options), RepositoryError, 'cleanup is incomplete');
    } finally {
      fs.rmSync = original;
      if (retained) original(retained, { recursive: true, force: true });
    }
    assert.equal(rulesetWrites().length, 1);
    assert.lengthOf(state.rulesets, 1);
  });
  it('requires creation-time proof of an empty bypass list', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    state.faults.rulesetDetail = 'omit-bypass';
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'permission-denied' });
    assert.equal(rulesetWrites().length, 1);
  });
  it('recovers on a fresh invocation after creation confirmation was unavailable', () => {
    const before = read(); state.requests = []; state.rulesets = [];
    state.faults.rulesetCreate = 'confirmation-failure';
    assert.equal(ensureManagedBranchRuleset(before, options).status, 'ambiguous');
    delete state.faults.rulesetCreate; delete state.faults.rulesetDetail;
    assert.deepEqual(ensureManagedBranchRuleset(before, options), { status: 'present' });
    assert.equal(rulesetWrites().length, 1);
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
    assert.equal(rulesetRequests().length, 0);
  });
  it('does not publish a true no-op', () => {
    const before = read();
    const after = publishRepositorySnapshots(before, new Map(), options);
    assert.strictEqual(after, before);
    assert.equal(publications().length, 0);
    assert.equal(rulesetRequests().length, 0);
  });
  it('does not require or recreate the non-authoritative README during ordinary reads or no-op backups', () => {
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
