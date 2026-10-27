// @ts-check
// Handwritten shared test responder. The gh child loads this without the TS facade.
// Types are imported only by the checker; each invocation still reads/writes plain JSON.
const fs = require('fs');
const crypto = require('crypto');
const repositoryConstants = () => /** @type {{managedBranchRulesetName: string}} */ (/** @type {unknown} */ (require('../../commands/backup_repository.ts')));
/** @typedef {import('./repository.ts').FixtureState} FixtureState */
/** @typedef {import('./repository.ts').FixtureRuleset} FixtureRuleset */
/** @typedef {import('./repository.ts').Response} Response */

/** @param {string} text */
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');
/** @param {string} base64 */
const blobHash = (base64) => {
  const bytes = Buffer.from(base64, 'base64');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
/** @param {Record<string, unknown>} [overrides] @returns {FixtureRuleset} */
const fixtureRuleset = (overrides = {}) => ({
  id: 1,
  name: repositoryConstants().managedBranchRulesetName,
  target: 'branch',
  source_type: 'Repository',
  source: 'fixture-user/ballin-backups',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  ...overrides,
});
/** @param {FixtureState} state @param {Record<string, string>} files @param {string[]} [parents] */
const commitFixture = (state, files, parents = [state.head]) => {
  const tree = hash(JSON.stringify(Object.entries(files).sort()));
  const head = hash(JSON.stringify([tree, parents, Object.keys(state.commits).length]));
  state.commits[head] = { files, parents, tree };
  state.head = head;
  return head;
};
/** @param {unknown} body @param {number} [status] @returns {Response} */
const reply = (body, status = 0) => ({ status, stdout: JSON.stringify(body), signal: null });
/** @param {FixtureState} state @param {string[]} args @param {import('child_process').SpawnSyncOptions} [options] @returns {Response} */
const requestFixture = (state, args, options = {}) => {
  if (args[0] === 'browse') {
    state.requests.push({ endpoint: 'open', method: 'GET', payload: { args }, environmentHost: options.env?.GH_HOST });
    const expected = ['browse', '--repo', `https://${state.host}/${state.login}/${state.name}`];
    if (JSON.stringify(args) !== JSON.stringify(expected)) return reply({}, 1);
    if (options.env && options.env.GH_HOST !== state.host) throw new Error('Browser fixture targeted the wrong host');
    return { ...reply({}, state.faults.open ? 7 : 0), stderr: state.faults.open ? 'DUMMY_PRIVATE_BROWSER_ERROR' : '' };
  }
  const methodIndex = args.indexOf('--method');
  const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
  const endpoint = methodIndex >= 0 ? args[methodIndex + 2] : args[3];
  const payload = options.input ? JSON.parse(String(options.input)) : undefined;
  const host = args[args.indexOf('--hostname') + 1];
  state.requests.push({ endpoint, method, payload, debug: options.env?.GH_DEBUG, host, environmentHost: options.env?.GH_HOST });
  if (host !== state.host || (options.env && options.env.GH_HOST !== state.host)) throw new Error('API fixture targeted the wrong host');
  const fault = state.faults;
  const transport = /** @type {{ target: string; response: Response } | undefined} */ (fault.transport);
  if (transport && (endpoint.includes(transport.target) || payload?.query?.includes(transport.target))) return transport.response;
  if (endpoint === 'user') {
    if (fault.auth) return reply({ message: 'dummy-secret-error', status: '401' }, 1);
    return reply(fault.user ?? { node_id: state.ownerId, login: state.login, type: 'User' });
  }
  if (method === 'GET' && endpoint.startsWith(`repos/${state.login}/`)) {
    const name = endpoint.slice(`repos/${state.login}/`.length);
    if ((/** @type {string[] | undefined} */ (fault.occupiedNames))?.includes(name)) {
      return reply({ node_id: `R_occupied_${name}`, name, default_branch: 'main', owner: { node_id: state.ownerId, type: 'User' } });
    }
  }
  if (endpoint === 'user/repos') {
    if (state.exists || fault.create === 'reject') return reply({ status: '422' }, 1);
    state.exists = true;
    state.name = payload.name;
    state.rulesets = [];
    commitFixture(state, { 'README.md': Buffer.from(`# ${state.name}\n`).toString('base64') }, []);
    if (fault.create === 'ambiguous') return reply({}, 1);
    return reply({ node_id: state.id, owner: { node_id: state.ownerId }, name: state.name, private: true, default_branch: state.branch,
      ...(/** @type {Record<string, unknown>} */ (fault.createdMetadata) ?? {}) });
  }
  if (method === 'PATCH' && endpoint === `repos/${state.login}/${state.name}`) {
    if (fault.features === 'denied') return reply({ status: '403' }, 1);
    if (fault.features === 'reject') return reply({ status: '422' }, 1);
    if (fault.features === 'ambiguous') return reply({}, 1);
    if (fault.features === 'malformed') return { status: 0, stdout: 'truncated JSON', signal: null };
    const unsupported = (/** @type {string[] | undefined} */ (fault.unsupportedFeatures) ?? []).filter(field => Object.hasOwn(payload, field));
    if (!unsupported.length || fault.partialFeatures) {
      for (const [field, value] of Object.entries(payload)) {
        if (!unsupported.includes(field)) state.featureSettings[field] = /** @type {boolean} */ (value);
      }
    }
    if (unsupported.length) return reply({ status: '422', errors: unsupported.map(field => ({
      resource: 'Repository', field, code: 'custom', message: 'This setting is not supported',
    })) }, 1);
    return reply({ node_id: state.id, name: state.name, private: true,
      owner: { node_id: state.ownerId, login: state.login, type: 'User' }, ...state.featureSettings,
      ...(/** @type {Record<string, unknown>} */ (fault.featureMetadata) ?? {}) });
  }
  if (endpoint === `repos/${state.login}/${state.name}` || endpoint === `repos/${state.login}/alternate` || endpoint === `repos/${state.login}/${fault.candidateAlias}`) {
    if (fault.candidate === 'redirect') return reply({ node_id: 'R_renamed', name: 'renamed-backup', private: false, owner: { node_id: state.ownerId, type: 'User' }, default_branch: state.branch, ...(/** @type {Record<string, unknown>} */ (fault.candidateMetadata) ?? {}) });
    if (!state.exists || fault.candidate === 'missing') return reply({ status: '404' }, 1);
    if (fault.candidate === 'denied') return reply({ status: '403' }, 1);
    return reply({ node_id: state.id, name: state.name, owner: { node_id: state.ownerId, type: 'User' }, default_branch: state.branch,
      ...(/** @type {Record<string, unknown>} */ (fault.candidateMetadata) ?? {}) });
  }
  const rulesetBase = `repos/${state.login}/${state.name}/rulesets`;
  if (method === 'GET' && endpoint === `${rulesetBase}?includes_parents=false&targets=branch&per_page=100`) {
    if (fault.rulesetList === 'denied') return reply({ message: 'Resource not accessible by token', status: '403' }, 1);
    if (fault.rulesetList === 'server') return reply({ message: 'Internal error', status: '500' }, 1);
    if (fault.rulesetList === 'malformed') return { status: 0, stdout: 'truncated JSON', signal: null };
    if (fault.rulesetList === 'object') return reply({ rulesets: state.rulesets });
    if (fault.rulesetList === 'invalid-id') return reply([{ id: 0, name: repositoryConstants().managedBranchRulesetName }]);
    if (fault.rulesetList === 'invalid-name') return reply([{ id: 1, name: 'bad\nname' }]);
    return reply(state.rulesets.map(({ id, name, enforcement }) => ({ id, name, enforcement })));
  }
  if (method === 'POST' && endpoint === rulesetBase) {
    const mode = fault.rulesetCreate;
    if (mode === 'plan') return reply({ message: 'Upgrade to GitHub Pro to use rulesets in private repositories', status: '422' }, 1);
    if (mode === 'plan-live-shape') return reply({ message: 'Upgrade your account or make this repository public to enable this feature', status: '422' }, 1);
    if (mode === 'plan-alternate') return reply({ message: 'Repository rulesets are not available for private repositories on this account', status: '403' }, 1);
    if (mode === 'plan-private-first') return reply({ message: 'Private repositories are not supported by rulesets on this account', status: '422' }, 1);
    if (mode === 'plan-public-alternative') return reply({ message: 'Rulesets are available if you make this repository public', status: '422' }, 1);
    if (mode === 'denied') return reply({ message: 'Resource not accessible by token', status: '403' }, 1);
    if (mode === 'admin-required') return reply({ message: 'This operation requires repository administration permission', status: '422' }, 1);
    if (mode === 'permission-missing') return reply({ message: 'Missing permission for repository policy', status: '403' }, 1);
    if (mode === 'forbidden') return reply({ message: 'Forbidden', status: '403' }, 1);
    if (mode === 'not-authorized') return reply({ message: 'Not authorized', status: '403' }, 1);
    if (mode === 'status-only-forbidden') return reply({ status: '403' }, 1);
    if (mode === 'status-only-missing') return reply({ status: '404' }, 1);
    if (mode === 'reject') return reply({ message: 'Validation failed', status: '422' }, 1);
    if (mode === 'generic-reject') return reply({ message: 'Request could not be processed', status: '422' }, 1);
    if (mode === 'rate-limit') return reply({ message: 'API rate limit exceeded', status: '403' }, 1);
    if (mode === 'spam') return reply({ message: 'The endpoint has been spammed', status: '422' }, 1);
    if (mode === 'server' || mode === 'ambiguous-no-effect') {
      return mode === 'server' ? reply({ message: 'Internal error', status: '500' }, 1) : reply({}, 1);
    }
    const created = fixtureRuleset({ ...payload, id: state.nextRulesetId++, source: `${state.login}/${state.name}` });
    if (!['no-effect', 'missing-id-no-effect'].includes(/** @type {string} */ (mode))) state.rulesets.push(created);
    if (mode === 'confirmation-failure') fault.rulesetDetail = 'server';
    if (mode === 'ambiguous') return reply({}, 1);
    if (mode === 'server-applied') return reply({ message: 'Internal error', status: '500' }, 1);
    if (mode === 'malformed') return { status: 0, stdout: 'truncated JSON', signal: null };
    if (mode === 'missing-id-applied' || mode === 'missing-id-no-effect') return reply({});
    return reply(created);
  }
  if (method === 'GET' && endpoint.startsWith(`${rulesetBase}/`)) {
    if (fault.rulesetDetail === 'denied') return reply({ message: 'Resource not accessible by token', status: '403' }, 1);
    if (fault.rulesetDetail === 'server' || fault.rulesetDetail === 'server-once') {
      if (fault.rulesetDetail === 'server-once') delete fault.rulesetDetail;
      return reply({ message: 'Internal error', status: '500' }, 1);
    }
    if (fault.rulesetDetail === 'malformed') return { status: 0, stdout: 'truncated JSON', signal: null };
    const id = Number(endpoint.slice(rulesetBase.length + 1).split('?')[0]);
    const found = state.rulesets.find((ruleset) => ruleset.id === id);
    if (!found || fault.rulesetDetail === 'missing') return reply({ status: '404' }, 1);
    /** @type {Record<string, unknown>} */
    const detail = { source: `${state.login}/${state.name}`, ...found };
    if (fault.rulesetDetail === 'omit-bypass') delete detail.bypass_actors;
    if (fault.rulesetDetail === 'wrong-source') detail.source = `${state.login}/other`;
    return reply(detail);
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
      ...(/** @type {Record<string, unknown>} */ (fault.node) ?? {}),
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
    if (content === undefined || fault.blob === 'unreadable' || fault.unreadableBlob === sha) return reply({}, 1);
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
/** @param {string} statePath @returns {void} */
const runFixtureCli = (statePath) => {
  /** @type {FixtureState} */
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const args = process.argv.slice(2);
  const response = requestFixture(state, args, { input: args.includes('--input') ? fs.readFileSync(0, 'utf8') : undefined, env: process.env });
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.status;
};
module.exports = { blobHash, fixtureRuleset, commitFixture, requestFixture, runFixtureCli };
