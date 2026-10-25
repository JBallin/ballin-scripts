const path = require('node:path');
const { normalizeBackupHost, parseBackupSetupArgs, configuredBackupDestination, resolveBackupSetupHost } = require('../commands/backup_config.ts');
const {
  readRepositoryAccount, candidateRepository, inspectRepository, requireRepositoryRead, createRepositoryBackup,
  ensureManagedBranchRuleset, publishRepositorySnapshots, repositoryUrl, repositoryCacheDirectory, sameRepositoryRevision,
  readRepositoryInventory, readRepositorySnapshot, inspectRepositoryMaintenance, repositoryOpenUrl, formatRepositoryMessage,
} = require('../commands/backup_repository.ts');
const { fixtureDestination, fixtureState, requestFixture } = require('./helpers/repository.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { SpawnSyncOptions } from 'node:child_process';
import type { FixtureState } from './helpers/repository.ts';

describe('backup host selection', () => {
  it('normalizes hostnames and keeps old repositories on GitHub.com despite stale host settings', () => {
    assert.equal(normalizeBackupHost('Git.Example.COM'), 'git.example.com');
    const legacy = { ...fixtureDestination }; delete legacy.host;
    const input = { backup: { host: 'git.example.com', repository: legacy } };
    assert.deepEqual(configuredBackupDestination(input), { kind: 'repository', repository: fixtureDestination });
    assert.notProperty(input.backup.repository, 'host');
    assert.equal(resolveBackupSetupHost(input), 'github.com');
    assert.equal(resolveBackupSetupHost({}), undefined);
    assert.equal(resolveBackupSetupHost({}, 'git.example.com'), 'git.example.com');
    assert.throws(() => resolveBackupSetupHost(input, 'git.example.com'), /Disconnect/u);
    assert.throws(() => resolveBackupSetupHost({}, 'https://git.example.com'), /hostname only/u);
  });
  for (const host of [null, '', 5, [], {}, 'https://git.example.com', 'http://git.example.com', 'git.example.com/path',
    'user@git.example.com', 'git.example.com:443', 'git.example.com?x', 'git.example.com#x', 'git.example.com\\path',
    ' git.example.com', 'git.example.com\n', '-git.example.com', 'git..example.com', 'git.example.com.',
    'git_example.com', 'gît.example.com', 'Kit.example.com', `${'a'.repeat(64)}.example.com`, 'a'.repeat(254)]) {
    it(`rejects invalid present hosts without fallback: ${JSON.stringify(host)}`, () => {
      assert.isNull(normalizeBackupHost(host));
      assert.equal(configuredBackupDestination({ backup: { repository: { ...fixtureDestination, host } } }).kind, 'invalid');
    });
  }
  it('accepts a single setup flag in either order and rejects ambiguous input', () => {
    for (const args of [['work-backups', '--hostname', 'Git.Example.com'], ['--hostname', 'Git.Example.com', 'work-backups']]) {
      assert.deepEqual(parseBackupSetupArgs(args), { repositoryName: 'work-backups', hostname: 'git.example.com' });
    }
    for (const args of [['--hostname'], ['--hostname', '--help'], ['--hostname', 'git.example.com', '--hostname', 'github.com'],
      ['a', 'b'], ['--unknown'], ['--hostname=git.example.com'], ['owner/repo'], ['--hostname', 'https://git.example.com']]) {
      assert.throws(() => parseBackupSetupArgs(args));
    }
  });
  it('preserves the existing GitHub.com cache namespace and separates equal IDs on other hosts', () => {
    const oldPath = path.join('/cache', '19aaf5ff846ea1e64b7a438cb120dd4fab92fd32c826533c1fda4cfd581bbd6a');
    assert.equal(repositoryCacheDirectory('/cache', fixtureDestination), oldPath);
    assert.notEqual(repositoryCacheDirectory('/cache', { ...fixtureDestination, host: 'git.example.com' }), oldPath);
  });
});

describe('host-bound repository transport', () => {
  for (const selectedHost of ['github.com', 'git.example.com', 'fixture.ghe.com']) {
    it(`uses an authenticated managed username for creation and publication on ${selectedHost}`, () => {
      const state: FixtureState = { ...fixtureState(), host: selectedHost, login: 'fixture_user', exists: false };
      const options = { runCommand: (_command: string, args: string[], opts: SpawnSyncOptions) => requestFixture(state, args, opts) };
      const account = readRepositoryAccount(selectedHost, options);
      const created = createRepositoryBackup(state.name, account, options);
      const after = publishRepositorySnapshots(created, new Map([['zshrc.sh', Buffer.from('managed backup\n')]]), options);
      assert.equal(after.snapshots.get('zshrc.sh').toString(), 'managed backup\n');
      assert.equal(repositoryOpenUrl(after.destination, options), `https://${selectedHost}/fixture_user/ballin-backups`);
      assert.isTrue(state.requests.every(r => r.host === selectedHost && r.environmentHost === selectedHost));
      state.faults.user = { node_id: 'U_other', login: state.login, type: 'User' };
      assert.equal(inspectRepository(after.destination, options).problem, 'identity');
    });
  }
  const host = 'git.example.com';
  const destination = { ...fixtureDestination, host };
  const setup = () => {
    const state: FixtureState = { ...fixtureState({ 'zshrc.sh': 'saved\n' }), host };
    const options = {
      env: testChildEnvironment({ GH_HOST: 'github.com', GH_REPO: 'github.com/other/other',
        GH_TOKEN: 'DUMMY_PUBLIC_TOKEN', GH_ENTERPRISE_TOKEN: 'DUMMY_ENTERPRISE_TOKEN', GH_DEBUG: 'api', DEBUG: '1' }),
      runCommand: (command: string, args: string[], opts: SpawnSyncOptions) => {
        assert.equal(command, 'gh');
        assert.equal(args[args.indexOf('--hostname') + 1], host);
        assert.equal(opts.env?.GH_HOST, host);
        assert.equal(opts.env?.GH_TOKEN, 'DUMMY_PUBLIC_TOKEN');
        assert.equal(opts.env?.GH_ENTERPRISE_TOKEN, 'DUMMY_ENTERPRISE_TOKEN');
        assert.equal(opts.env?.GH_DEBUG, ''); assert.equal(opts.env?.DEBUG, '');
        return requestFixture(state, args, opts);
      },
    };
    return { state, options };
  };
  it('keeps reads and publication separate when two services return identical stable IDs', () => {
    const publicState = fixtureState({ 'zshrc.sh': 'public account\n' });
    const enterpriseState = { ...fixtureState({ 'zshrc.sh': 'work account\n' }), host };
    const servers = new Map<string, FixtureState>([['github.com', publicState], [host, enterpriseState]]);
    const options = { runCommand: (_command: string, args: string[], opts: SpawnSyncOptions) => {
      const selected = servers.get(args[args.indexOf('--hostname') + 1]);
      assert.exists(selected);
      return requestFixture(selected!, args, opts);
    } };
    const publicHead = publicState.head;
    assert.equal(readRepositorySnapshot(fixtureDestination, 'zshrc.sh', options).toString(), 'public account\n');
    const before = requireRepositoryRead(inspectRepository(destination, options));
    assert.equal(before.snapshots.get('zshrc.sh').toString(), 'work account\n');
    publishRepositorySnapshots(before, new Map([['zshrc.sh', Buffer.from('work changed\n')]]), options);
    assert.equal(readRepositorySnapshot(destination, 'zshrc.sh', options).toString(), 'work changed\n');
    assert.equal(publicState.head, publicHead);
    assert.equal(readRepositorySnapshot(fixtureDestination, 'zshrc.sh', options).toString(), 'public account\n');
  });
  it('routes identity, creation, protection, readers, publication and final checks to the saved host', () => {
    const { state, options } = setup(); state.exists = false; state.rulesets = [];
    const account = readRepositoryAccount(host, options);
    const created = createRepositoryBackup(state.name, account, options);
    assert.deepEqual(created.destination, destination);
    assert.equal(ensureManagedBranchRuleset(created, options).status, 'enabled');
    const before = publishRepositorySnapshots(created, new Map([['zshrc.sh', Buffer.from('saved\n')]]), options);
    const count = state.requests.filter((r) => r.payload?.query?.includes('BallinPublish')).length;
    const unchanged = publishRepositorySnapshots(before, new Map(), options);
    assert.equal(state.requests.filter((r) => r.payload?.query?.includes('BallinPublish')).length, count);
    assert.equal(candidateRepository(state.name, account, options).host, host);
    assert.isTrue(sameRepositoryRevision(before, unchanged));
    assert.isFalse(sameRepositoryRevision(before, { ...before, destination: { ...destination, host: 'github.com' } }));
    assert.isFalse(sameRepositoryRevision(before, { ...before, destination: { ...destination, ownerId: 'U_other' } }));
    assert.include(before.commitUrl, `https://${host}/fixture-user/ballin-backups/commit/`);
    assert.equal(repositoryOpenUrl(destination, options), `https://${host}/fixture-user/ballin-backups`);
    assert.equal(readRepositorySnapshot(destination, 'zshrc.sh', options).toString(), 'saved\n');
    assert.isAbove(readRepositoryInventory(destination, options).entries.length, 0);
    assert.equal(inspectRepositoryMaintenance(destination, options).destination.host, host);
    assert.throws(() => repositoryUrl(destination, { ...account, host: 'github.com' }), /does not match/u);
    assert.isTrue(state.requests.every((r) => r.host === host && r.environmentHost === host));
    assert.notInclude(JSON.stringify(state.requests), 'DUMMY_PUBLIC_TOKEN');
    assert.notInclude(JSON.stringify(state.requests), 'DUMMY_ENTERPRISE_TOKEN');
  });
  it('keeps failed custom-host authentication on that host and supplies the correct recovery command', () => {
    const { state, options } = setup(); state.faults.auth = true;
    const result = inspectRepository(destination, options);
    assert.equal(result.problem, 'authentication');
    assert.deepEqual(state.requests.map((r) => [r.endpoint, r.host]), [['user', host]]);
    const message = formatRepositoryMessage(result.problem, {}, host);
    assert.include(message, 'gh auth login --hostname git.example.com');
    assert.notInclude(message, 'github.com');
  });
  it('preserves literal hosts containing github.com in recovery messages', () => {
    const selectedHost = `github.com.${host}`;
    assert.equal(formatRepositoryMessage('authentication', {}, selectedHost),
      `${selectedHost} authentication is required. Run \`gh auth login --hostname ${selectedHost}\`, or check the effective gh account and environment token, then retry.`);
    for (const problem of ['connection', 'timeout', 'request'] as const) {
      const message = formatRepositoryMessage(problem, {}, selectedHost);
      assert.include(message, selectedHost);
      assert.notInclude(message, `${selectedHost}.${host}`);
    }
  });
  it('rejects an invalid transport host before invoking the runner', () => {
    let calls = 0;
    assert.throws(() => readRepositoryAccount('https://git.example.com', {
      runCommand: () => { calls += 1; throw new Error('must not run'); },
    }), /invalid backup metadata/u);
    assert.equal(calls, 0);
  });
  for (const fault of ['wrong owner', 'optional policy unavailable', 'missing GraphQL']) {
    it(`preserves safety on the custom host for ${fault}`, () => {
      const { state, options } = setup();
      if (fault === 'wrong owner') {
        state.faults.node = { owner: { __typename: 'Organization', id: state.ownerId, login: state.login } };
        assert.equal(inspectRepository(destination, options).status, 'incomplete');
      } else if (fault === 'optional policy unavailable') {
        const read = requireRepositoryRead(inspectRepository(destination, options));
        state.faults.transport = { target: '/rulesets', response: { status: 1, stdout: '{"status":"404"}', signal: null } };
        assert.equal(ensureManagedBranchRuleset(read, options).status, 'ambiguous');
      } else {
        state.exists = false;
        state.faults.transport = { target: 'BallinPublish', response: { status: 0,
          stdout: '{"errors":[{"message":"Field createCommitOnBranch is not defined"}]}', signal: null } };
        assert.throws(() => createRepositoryBackup(state.name, readRepositoryAccount(host, options), options));
      }
      assert.isTrue(state.requests.every((r) => r.host === host));
    });
  }
});
