const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { repositoryReadmeContents } = require('../../commands/backup_repository.ts');
import type { SpawnSyncOptions } from 'child_process';

type FixtureCommit = { files: Record<string, string>; parents: string[]; tree: string };
type Request = { endpoint: string; method: string; payload?: { query?: string; variables?: Record<string, unknown>; [key: string]: unknown }; debug?: string };
type FixtureState = {
  exists: boolean; id: string; ownerId: string; login: string; name: string; branch: string; head: string;
  commits: Record<string, FixtureCommit>; requests: Request[];
  faults: Record<string, unknown>;
};
type Response = { status: number; stdout: string; signal: null };
const hash = (text: string): string => crypto.createHash('sha1').update(text).digest('hex');
const blobHash = (base64: string): string => {
  const bytes = Buffer.from(base64, 'base64');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const fixtureDestination = { id: 'R_fixture', ownerId: 'U_fixture', name: 'ballin-backups', branch: 'main' };
const fixtureMarker = (): string => JSON.stringify({
  format: 'ballin-backup', version: 1, repositoryId: fixtureDestination.id, ownerId: fixtureDestination.ownerId,
}) + '\n';
const commitFixture = (state: FixtureState, files: Record<string, string>, parents: string[] = [state.head]): string => {
  const tree = hash(JSON.stringify(Object.entries(files).sort()));
  const head = hash(JSON.stringify([tree, parents, Object.keys(state.commits).length]));
  state.commits[head] = { files, parents, tree };
  state.head = head;
  return head;
};
const fixtureState = (snapshots: Record<string, string> = {}): FixtureState => {
  const state: FixtureState = { exists: true, ...fixtureDestination, login: 'fixture-user', head: '', commits: {}, requests: [], faults: {} };
  const files = {
    '.ballin-backup.json': fixtureMarker(),
    'README.md': repositoryReadmeContents,
    ...snapshots,
  };
  commitFixture(state, Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value).toString('base64')])), []);
  return state;
};
const reply = (body: unknown, status = 0): Response => ({ status, stdout: JSON.stringify(body), signal: null });
const requestFixture = (state: FixtureState, args: string[], options: SpawnSyncOptions = {}): Response => {
  if (args[0] === 'repo') { state.requests.push({ endpoint: 'open', method: 'GET' }); return reply({}); }
  const methodIndex = args.indexOf('--method');
  const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
  const endpoint = methodIndex >= 0 ? args[methodIndex + 2] : args[3];
  const payload = options.input ? JSON.parse(String(options.input)) : undefined;
  state.requests.push({ endpoint, method, payload, debug: options.env?.GH_DEBUG });
  const fault = state.faults;
  if (endpoint === 'user') {
    if (fault.auth) return reply({ message: 'dummy-secret-error', status: '401' }, 1);
    return reply(fault.user ?? { node_id: state.ownerId, login: state.login, type: 'User' });
  }
  if (endpoint === 'user/repos') {
    if (state.exists || fault.create === 'reject') return reply({ status: '422' }, 1);
    state.exists = true;
    state.name = payload.name;
    commitFixture(state, { 'README.md': Buffer.from(`# ${state.name}\n`).toString('base64') }, []);
    if (fault.create === 'ambiguous') return reply({}, 1);
    return reply({ node_id: state.id, owner: { node_id: state.ownerId }, name: state.name, private: true, default_branch: state.branch,
      ...(fault.createdMetadata as Record<string, unknown> ?? {}) });
  }
  if (endpoint === `repos/${state.login}/${state.name}` || endpoint === `repos/${state.login}/alternate`) {
    if (!state.exists || fault.candidate === 'missing') return reply({ status: '404' }, 1);
    if (fault.candidate === 'denied') return reply({ status: '403' }, 1);
    return reply({ node_id: state.id, owner: { node_id: state.ownerId, type: 'User' }, default_branch: state.branch,
      ...(fault.candidateMetadata as Record<string, unknown> ?? {}) });
  }
  if (endpoint === 'graphql' && payload.query.includes('BallinRepository')) {
    if (fault.query === 'errors') return reply({ errors: [{ type: 'FORBIDDEN' }] });
    if (!state.exists || payload.variables.id !== state.id || fault.query === 'missing') return reply({ data: { node: null } });
    const current = state.commits[state.head];
    const node = {
      id: state.id, name: state.name, isPrivate: true, isFork: false, isArchived: false, isDisabled: false,
      owner: { __typename: 'User', id: state.ownerId, login: state.login }, defaultBranchRef: { name: state.branch },
      ref: { id: `REF_${state.id}_${state.branch}`, name: state.branch,
        target: { __typename: 'Commit', oid: state.head, tree: { oid: current.tree },
          parents: { nodes: current.parents.map((oid) => ({ oid })), pageInfo: { hasNextPage: false } } } },
      ...(fault.node as Record<string, unknown> ?? {}),
    };
    return reply({ data: { node } });
  }
  if (endpoint.includes('/git/trees/')) {
    const tree = endpoint.split('/git/trees/')[1].split('?')[0];
    const commit = Object.values(state.commits).find((commit) => commit.tree === tree);
    if (!commit || fault.tree === 'unreadable') return reply({}, 1);
    return reply({ sha: tree, truncated: false,
      tree: Object.entries(commit.files).map(([name, content]) => ({ path: name, sha: blobHash(content), size: Buffer.from(content, 'base64').length, type: 'blob', mode: '100644' })),
      ...(typeof fault.tree === 'object' ? fault.tree : {}),
    });
  }
  if (endpoint.includes('/git/blobs/')) {
    const sha = endpoint.split('/git/blobs/')[1];
    const content = Object.values(state.commits).flatMap((commit) => Object.values(commit.files)).find((content) => blobHash(content) === sha);
    if (content === undefined || fault.blob === 'unreadable') return reply({}, 1);
    return reply({ sha, size: Buffer.from(content, 'base64').length, content, encoding: 'base64',
      ...(typeof fault.blob === 'object' ? fault.blob : {}),
    });
  }
  if (endpoint === 'graphql' && payload.query.includes('BallinPublish')) {
    const input = payload.variables.input;
    const before = state.head;
    if (fault.publish === 'advance') commitFixture(state, { ...state.commits[before].files, extra: Buffer.from('competing change\n').toString('base64') });
    if (fault.publish === 'rewind') state.head = state.commits[before].parents[0] ?? hash('different head');
    if (input.expectedHeadOid !== state.head || fault.publish === 'reject') {
      return reply({ data: { createCommitOnBranch: null }, errors: [{ type: 'STALE_DATA' }] }, 1);
    }
    if (fault.publish === 'denied') return reply({ data: null, errors: [{ type: 'FORBIDDEN' }] }, 1);
    if (input.branch.id !== `REF_${state.id}_${state.branch}`) return reply({ errors: [{ type: 'NOT_FOUND' }] }, 1);
    const files = { ...state.commits[before].files };
    for (const addition of input.fileChanges.additions) files[addition.path] = addition.contents;
    for (const deletion of input.fileChanges.deletions ?? []) delete files[deletion.path];
    const created = commitFixture(state, files);
    if (fault.publish === 'orphan') { state.head = before; return reply({}, 1); }
    if (fault.publish === 'wrong-readback') commitFixture(state, { ...files, extra: Buffer.from('unexpected\n').toString('base64') });
    if (fault.publish === 'ambiguous') return reply({}, 1);
    if (fault.publish === 'malformed') return { status: 0, stdout: 'truncated JSON', signal: null };
    return reply({ data: { createCommitOnBranch: { commit: { oid: fault.returnedCommit ?? created } } } });
  }
  return reply({ status: '404' }, 1);
};
const installRepositoryFixture = (directory: string, statePath: string): void => {
  const helper = path.join(__dirname, 'repository.ts');
  fs.writeFileSync(path.join(directory, 'gh'), `#!${process.execPath}\nrequire(${JSON.stringify(helper)}).runFixtureCli(${JSON.stringify(statePath)});\n`, { mode: 0o755 });
};
const runFixtureCli = (statePath: string): void => {
  const state: FixtureState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const args = process.argv.slice(2);
  const response = requestFixture(state, args, { input: args.includes('--input') ? fs.readFileSync(0, 'utf8') : undefined, env: process.env });
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(response.stdout);
  process.exitCode = response.status;
};
module.exports = { fixtureDestination, fixtureMarker, fixtureState, commitFixture, requestFixture, installRepositoryFixture, runFixtureCli, blobHash };
export type { FixtureState, FixtureCommit, Request };
