const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeTempFile, removeTempFile, runCommand, writeStderrLine } = require('./commandHelpers.ts');
const { isConfigObject, validRepositoryName } = require('./backup_config.ts');
const {
  classifySnapshotFileName,
  repositoryMarkerFileName,
  repositoryReadmeFileName,
} = require('./backup_snapshots.ts');
import type { RepositoryDestination } from './backup_config.ts';
import type { SnapshotNameClassification } from './backup_snapshots.ts';
import type { SpawnSyncOptions } from 'child_process';

type RepositoryProblem = 'authentication' | 'unavailable' | 'identity' | 'unsupported'
  | 'invalid-data' | 'incomplete' | 'moved' | 'rejected' | 'uncertain' | 'local-io' | 'cleanup';
const repositoryMessages: Record<RepositoryProblem, string> = {
  authentication: 'GitHub.com authentication is required; check the effective gh account and environment token.',
  unavailable: 'The backup repository is missing or inaccessible. Check access; this does not prove it was deleted.',
  identity: 'The repository or personal owner does not match the selected backup. Revalidate with ballin backup setup.',
  unsupported: 'The repository is not a supported private Ballin destination. Inspect it deliberately in GitHub.',
  'invalid-data': 'GitHub returned invalid backup metadata or content; no complete comparison is possible.',
  incomplete: 'The repository could not be read completely; no missing snapshots can be inferred.',
  moved: 'The selected backup changed during inspection. Rerun to read and reconcile the current state.',
  rejected: 'GitHub rejected backup publication. Check access and branch restrictions, then rerun to reconcile.',
  uncertain: 'Backup publication is unconfirmed. Cache contents were not advanced; rerun to read and reconcile.',
  cleanup: 'Private temporary-file cleanup is incomplete; any completed remote effects are retained.',
  'local-io': 'Unable to prepare private backup transport files. Check local storage and permissions.',
};
class RepositoryError extends Error {
  readonly problem: RepositoryProblem;
  completedStage?: 'repository-created';
  cleanupFailed?: boolean;
  constructor(problem: RepositoryProblem) {
    super(repositoryMessages[problem]);
    this.problem = problem;
  }
}
type RepositoryOptions = {
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], options: SpawnSyncOptions) => {
    status: number | null; signal?: string | null; error?: Error; stdout?: string;
  };
};
type Account = { id: string; login: string };
type Entry = { path: string; sha: string; size: number; classification: SnapshotNameClassification };
// A revision is a storage-local handle. Callers pass it back without interpreting Git objects.
type Revision = { head: string; tree: string; branchId: string; parents: string[]; entries: Entry[] };
type RepositoryRead = {
  destination: RepositoryDestination;
  revision: Revision;
  snapshots: Map<string, Buffer>;
};
type ManagedBranchRulesetOutcome =
  | { status: 'present' }
  | { status: 'enabled' }
  | { status: 'unsupported' }
  | { status: 'permission-denied' }
  | { status: 'unexpected' }
  | { status: 'ambiguous'; reason: 'unconfirmed' | 'mismatch' | 'duplicate' };
type RepositoryInspection =
  | { status: 'complete'; read: RepositoryRead }
  | { status: 'incomplete'; problem: RepositoryProblem; inspected?: RepositoryRead };
type RepositoryInfo = { destination: RepositoryDestination; login: string; revision: Revision };
type ApiResult = { ok: boolean; body: Record<string, unknown>; items?: unknown[]; cleanupFailed?: boolean };
const requireCleanTransport = (result: ApiResult): void => {
  if (result.cleanupFailed) throw new RepositoryError('cleanup');
};

const object = (value: unknown): Record<string, unknown> => {
  if (!isConfigObject(value)) throw new RepositoryError('invalid-data');
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new RepositoryError('invalid-data');
  }
  return value;
};
const oid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) throw new RepositoryError('invalid-data');
  return value;
};
const api = (endpoint: string, payload: unknown, options: RepositoryOptions, allowArray = false): ApiResult => {
  let output: string | undefined;
  let response: ApiResult = { ok: false, body: {} };
  let failure: RepositoryError | undefined;
  try {
    output = makeTempFile('ballin-repository-');
    const fd = fs.openSync(output, 'wx', 0o600);
    let result;
    try {
      result = (options.runCommand ?? runCommand)('gh', [
        'api', '--hostname', 'github.com', '--method', payload === undefined ? 'GET' : 'POST',
        endpoint, ...(payload === undefined ? [] : ['--input', '-']),
      ], {
        env: { ...(options.env ?? process.env), GH_HOST: 'github.com', GH_DEBUG: '', DEBUG: '' },
        input: payload === undefined ? undefined : JSON.stringify(payload),
        stdio: [payload === undefined ? 'ignore' : 'pipe', fd, 'pipe'],
      });
    } finally { fs.closeSync(fd); }
    // The injected runner used by readiness fixtures may return stdout directly.
    const contents = result.stdout || fs.readFileSync(output, 'utf8');
    let body: Record<string, unknown> = {};
    let items: unknown[] | undefined;
    try {
      const parsed: unknown = JSON.parse(contents);
      if (Array.isArray(parsed) && allowArray) items = parsed;
      else body = object(parsed);
    } catch {
      if (result.status === 0 && !result.error && !result.signal) throw new RepositoryError('invalid-data');
    }
    response = { ok: result.status === 0 && !result.error && !result.signal, body, items };
  } catch (error) {
    failure = error instanceof RepositoryError ? error : new RepositoryError('local-io');
  } finally {
    if (output) {
      try { removeTempFile(output); } catch {
        writeStderrLine(`ballin backup: ${repositoryMessages.cleanup}`);
        response.cleanupFailed = true;
        if (failure) failure.cleanupFailed = true;
      }
    }
  }
  // Keep response/error evidence for callers to classify before refusing success.
  if (failure) throw failure;
  return response;
};
const query = (document: string, variables: Record<string, unknown>, options: RepositoryOptions): Record<string, unknown> => {
  const result = api('graphql', { query: document, variables }, options);
  if (!result.ok || result.body.errors) throw new RepositoryError('unavailable');
  requireCleanTransport(result);
  return object(result.body.data);
};
const readRepositoryAccount = (options: RepositoryOptions = {}): Account => {
  const result = api('user', undefined, options);
  if (!result.ok) throw new RepositoryError('authentication');
  if (result.body.type !== 'User') throw new RepositoryError('identity');
  const login = identifier(result.body.login);
  if (!/^[A-Za-z0-9-]+$/u.test(login)) throw new RepositoryError('invalid-data');
  const id = identifier(result.body.node_id);
  requireCleanTransport(result);
  return { id, login };
};
const repositoryFields = `id name isPrivate isFork isArchived isDisabled
  owner { __typename id login }
  defaultBranchRef { name }
  ref(qualifiedName: $branch) { id name target { __typename ... on Commit {
    oid tree { oid } parents(first: 2) { nodes { oid } pageInfo { hasNextPage } }
  } } }`;
const readInfo = (
  destination: RepositoryDestination, account: Account, options: RepositoryOptions,
): RepositoryInfo => {
  const data = query(`query BallinRepository($id: ID!, $branch: String!) {
    node(id: $id) { ... on Repository { ${repositoryFields} } }
  }`, { id: destination.id, branch: `refs/heads/${destination.branch}` }, options);
  if (!data.node) throw new RepositoryError('unavailable');
  const node = object(data.node);
  const owner = object(node.owner);
  if (node.id !== destination.id || owner.id !== destination.ownerId || owner.id !== account.id || owner.__typename !== 'User') {
    throw new RepositoryError('identity');
  }
  if (node.isPrivate !== true || node.isFork !== false || node.isArchived !== false || node.isDisabled !== false) {
    throw new RepositoryError('unsupported');
  }
  if (!validRepositoryName(node.name) || owner.login !== account.login) throw new RepositoryError('identity');
  if (!node.ref) throw new RepositoryError('unsupported');
  const ref = object(node.ref);
  const target = object(ref.target);
  if (ref.name !== destination.branch || target.__typename !== 'Commit') throw new RepositoryError('unsupported');
  const parents = object(target.parents);
  if (!Array.isArray(parents.nodes) || object(parents.pageInfo).hasNextPage !== false) throw new RepositoryError('incomplete');
  return {
    destination: { ...destination, name: node.name as string }, login: account.login,
    revision: {
      head: oid(target.oid), tree: oid(object(target.tree).oid), branchId: identifier(ref.id),
      parents: parents.nodes.map((parent) => oid(object(parent).oid)), entries: [],
    },
  };
};
const candidateRepository = (name: string, account: Account, options: RepositoryOptions = {}): RepositoryDestination | null => {
  if (!validRepositoryName(name)) throw new RepositoryError('invalid-data');
  const result = api(`repos/${account.login}/${name}`, undefined, options);
  if (!result.ok) {
    if (String(result.body.status) === '404') {
      requireCleanTransport(result);
      return null; // Absence is ambiguous; only explicit creation may follow.
    }
    throw new RepositoryError('unavailable');
  }
  const owner = object(result.body.owner);
  if (owner.node_id !== account.id || owner.type !== 'User') throw new RepositoryError('identity');
  requireCleanTransport(result);
  return {
    id: identifier(result.body.node_id), ownerId: account.id,
    name, branch: identifier(result.body.default_branch),
  };
};
const markerBytes = (destination: RepositoryDestination): Buffer => Buffer.from(`${JSON.stringify({
  format: 'ballin-backup', version: 1, repositoryId: destination.id, ownerId: destination.ownerId,
})}\n`);
const repositoryReadmeContents = `# Ballin backup

This repository was created by [Ballin](https://github.com/JBallin/ballin-scripts) to store snapshots of your development environment.

\`ballin_config\` stores selected Ballin preferences that are portable between installations, not a complete copy of your local Ballin configuration.

For current backup behavior and guidance, see the [Ballin documentation](https://github.com/JBallin/ballin-scripts/tree/main/docs).

Ballin uses \`.ballin-backup.json\` to identify this repository as a Ballin backup.
`;
const repositoryReadmeBytes = (): Buffer => Buffer.from(repositoryReadmeContents);
const blobOid = (bytes: Buffer): string => crypto.createHash('sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const readInventory = (info: RepositoryInfo, options: RepositoryOptions): Entry[] => {
  const result = api(`repos/${info.login}/${info.destination.name}/git/trees/${info.revision.tree}?recursive=1`, undefined, options);
  if (!result.ok) throw new RepositoryError('incomplete');
  requireCleanTransport(result);
  const data = result.body;
  if (data.truncated !== false) throw new RepositoryError('incomplete');
  if (data.sha !== info.revision.tree || !Array.isArray(data.tree)) throw new RepositoryError('invalid-data');
  const names = new Set<string>();
  return data.tree.map((value) => {
    const entry = object(value);
    if (typeof entry.path !== 'string' || !entry.path || names.has(entry.path)) throw new RepositoryError('invalid-data');
    names.add(entry.path);
    if (
      entry.path.includes('/') || entry.path.includes('\\') || entry.path === '.' || entry.path === '..'
      || /[\x00-\x1f\x7f]/u.test(entry.path) || entry.type !== 'blob' || entry.mode !== '100644'
      || entry.path === '.github'
    ) throw new RepositoryError('unsupported');
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new RepositoryError('invalid-data');
    return { path: entry.path, sha: oid(entry.sha), size: entry.size, classification: classifySnapshotFileName(entry.path) };
  });
};
const readBlob = (info: RepositoryInfo, entry: Entry, options: RepositoryOptions): Buffer => {
  const result = api(`repos/${info.login}/${info.destination.name}/git/blobs/${entry.sha}`, undefined, options);
  if (!result.ok) throw new RepositoryError('incomplete');
  requireCleanTransport(result);
  const data = result.body;
  if (data.sha !== entry.sha || data.size !== entry.size || data.encoding !== 'base64'
    || typeof data.content !== 'string' || data.truncated === true) throw new RepositoryError('invalid-data');
  const encoded = data.content.replace(/[\r\n]/gu, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== entry.size || blobOid(bytes) !== entry.sha) {
    throw new RepositoryError('invalid-data');
  }
  return bytes;
};
const assertCurrent = (read: RepositoryRead, options: RepositoryOptions = {}): void => {
  const info = readInfo(read.destination, readRepositoryAccount(options), options);
  if (info.revision.head !== read.revision.head || info.revision.branchId !== read.revision.branchId
    || info.revision.tree !== read.revision.tree) throw new RepositoryError('moved');
};
const inspect = (
  destination: RepositoryDestination, account: Account, options: RepositoryOptions, seed: boolean,
): RepositoryInspection => {
  let inspected: RepositoryRead | undefined;
  try {
    const info = readInfo(destination, account, options);
    inspected = { destination: info.destination, revision: info.revision, snapshots: new Map() };
    info.revision.entries = readInventory(info, options);
    for (const entry of info.revision.entries) {
      if (entry.classification === 'current' || entry.path === repositoryMarkerFileName || (seed && entry.path === repositoryReadmeFileName)) {
        inspected.snapshots.set(entry.path, readBlob(info, entry, options));
      }
    }
    if (seed) {
      if (info.revision.parents.length !== 0 || info.revision.entries.length !== 1 || !inspected.snapshots.has(repositoryReadmeFileName)) {
        throw new RepositoryError('unsupported');
      }
    } else {
      const marker = inspected.snapshots.get(repositoryMarkerFileName);
      if (!marker || !marker.equals(markerBytes(destination))) throw new RepositoryError('unsupported');
    }
    assertCurrent(inspected, options);
    return { status: 'complete', read: inspected };
  } catch (error) {
    return { status: 'incomplete', inspected, problem: error instanceof RepositoryError ? error.problem : 'local-io' };
  }
};
const inspectRepository = (destination: RepositoryDestination, options: RepositoryOptions = {}): RepositoryInspection => {
  try { return inspect(destination, readRepositoryAccount(options), options, false); } catch (error) {
    return { status: 'incomplete', problem: error instanceof RepositoryError ? error.problem : 'local-io' };
  }
};
const requireRepositoryRead = (inspection: RepositoryInspection): RepositoryRead => {
  if (inspection.status !== 'complete') throw new RepositoryError(inspection.problem);
  return inspection.read;
};
const sameRepositoryRevision = (left: RepositoryRead, right: RepositoryRead): boolean => (
  left.destination.id === right.destination.id && left.revision.branchId === right.revision.branchId
  && left.revision.head === right.revision.head && left.revision.tree === right.revision.tree
);
const unexpectedRepositoryEntries = (read: RepositoryRead): number => (
  read.revision.entries.filter((entry) => entry.classification === 'unexpected').length
);
const managedBranchRulesetName = 'Ballin backup branch protection';
const managedBranchRulesetPayload = (branch: string): Record<string, unknown> => ({
  name: managedBranchRulesetName,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
});
const apiStatus = (result: ApiResult): number | undefined => {
  const status = typeof result.body.status === 'string' ? Number(result.body.status) : result.body.status;
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
};
type ProtectionApiOutcome = 'unsupported' | 'permission-denied' | 'unexpected' | 'ambiguous';
const responseText = (value: Record<string, unknown>): string => JSON.stringify(value).toLowerCase();
const classifyProtectionApiFailure = (result: ApiResult): ProtectionApiOutcome => {
  const message = responseText(result.body);
  const status = apiStatus(result);
  const namesCapability = /rulesets?|branch protection/u.test(message);
  const offersPublicAlternative = /make (?:this |the )?repository public/u.test(message);
  if ((namesCapability && (
    /(?:upgrade|paid|pro plan|team plan|enterprise plan)/u.test(message)
    || /(?:not available|not supported|not enabled|unavailable).*(?:private|repository|account|plan)/u.test(message)
    || /(?:private|repository|account|plan).*(?:not available|not supported|not enabled|unavailable)/u.test(message)
    || offersPublicAlternative
  )) || (/(?:upgrade|paid|\bpro\b)/u.test(message) && offersPublicAlternative)) return 'unsupported';
  if (
    /resource not accessible by (?:personal access )?token/u.test(message)
    || /(?:requires?|must have|need).*(?:admin|administration).*(?:access|permission|role)?/u.test(message)
    || /(?:insufficient|missing).*(?:permission|authority|access)/u.test(message)
  ) return 'permission-denied';
  if (/rate limit|abuse|spam|submitted too quickly|temporar(?:y|ily)|timeout/u.test(message)) return 'ambiguous';
  if (status !== undefined && status >= 500) return 'ambiguous';
  if (/validation failed|invalid (?:request|value|ruleset|condition|rule)/u.test(message)) return 'unexpected';
  if ([400, 409, 422].includes(status ?? 0) && message.trim()) return 'unexpected';
  return 'ambiguous';
};
const rulesetId = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new RepositoryError('invalid-data');
  return value;
};
const semanticStringSet = (value: unknown, expected: string[]): boolean => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return false;
  const actual = [...new Set(value as string[])].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === [...expected].sort()[index]);
};
const harmlessRepresentation = (value: unknown): boolean => (
  value === undefined || value === null || value === false || value === ''
  || (Array.isArray(value) && value.length === 0)
  || (isConfigObject(value) && Object.values(value).every(harmlessRepresentation))
);
const managedBranchRulesetMatch = (
  value: unknown, id: number, read: RepositoryRead, account: Account,
): 'match' | 'permission-denied' | 'mismatch' => {
  try {
    const ruleset = object(value);
    const conditions = object(ruleset.conditions);
    const refName = object(conditions.ref_name);
    if (
      ruleset.id !== id || ruleset.name !== managedBranchRulesetName
      || ruleset.target !== 'branch' || ruleset.enforcement !== 'active'
      || ruleset.source_type !== 'Repository' || typeof ruleset.source !== 'string'
      || ruleset.source.toLowerCase() !== `${account.login}/${read.destination.name}`.toLowerCase()
      || !Object.hasOwn(conditions, 'ref_name')
      || Object.entries(conditions).some(([key, entry]) => key !== 'ref_name' && !harmlessRepresentation(entry))
      || Object.entries(refName).some(([key, entry]) => !['include', 'exclude'].includes(key) && !harmlessRepresentation(entry))
      || !semanticStringSet(refName.include, [`refs/heads/${read.destination.branch}`])
      || !semanticStringSet(refName.exclude, []) || !Array.isArray(ruleset.rules) || ruleset.rules.length !== 2
    ) return 'mismatch';
    const ruleTypes = ruleset.rules.map((rule) => {
      const entry = object(rule);
      if (typeof entry.type !== 'string') throw new RepositoryError('invalid-data');
      if (Object.entries(entry).some(([key, item]) => (
        key !== 'type' && !['id', 'node_id', 'created_at', 'updated_at'].includes(key) && !harmlessRepresentation(item)
      ))) return undefined;
      return entry.type as string;
    }).sort();
    if (!semanticStringSet(ruleTypes, ['deletion', 'non_fast_forward'])) return 'mismatch';
    if (ruleset.bypass_actors === undefined) return 'permission-denied';
    if (!semanticStringSet(ruleset.bypass_actors, [])) return 'mismatch';
    return 'match';
  } catch { return 'mismatch'; }
};
const readManagedBranchRuleset = (
  base: string, id: number, read: RepositoryRead, account: Account, options: RepositoryOptions,
): 'match' | 'permission-denied' | 'mismatch' | ProtectionApiOutcome => {
  let detail: ApiResult;
  try { detail = api(`${base}/${id}?includes_parents=false`, undefined, options); } catch (error) {
    if (error instanceof RepositoryError && ['local-io', 'cleanup'].includes(error.problem)) throw error;
    return 'ambiguous';
  }
  if (!detail.ok) {
    requireCleanTransport(detail);
    return classifyProtectionApiFailure(detail);
  }
  requireCleanTransport(detail);
  return managedBranchRulesetMatch(detail.body, id, read, account);
};
const findManagedBranchRuleset = (
  read: RepositoryRead, account: Account, options: RepositoryOptions,
): { status: 'missing' } | { status: 'found'; result: ReturnType<typeof readManagedBranchRuleset> }
  | { status: ProtectionApiOutcome } | { status: 'duplicate' } => {
  const base = `repos/${account.login}/${read.destination.name}/rulesets`;
  let list: ApiResult;
  try { list = api(`${base}?includes_parents=false&targets=branch&per_page=100`, undefined, options, true); } catch (error) {
    if (error instanceof RepositoryError && ['local-io', 'cleanup'].includes(error.problem)) throw error;
    return { status: 'ambiguous' };
  }
  if (!list.ok) {
    requireCleanTransport(list);
    return { status: classifyProtectionApiFailure(list) };
  }
  requireCleanTransport(list);
  if (!list.items) return { status: 'ambiguous' };
  let named: Record<string, unknown>[];
  try {
    named = list.items.map((value) => {
      const ruleset = object(value);
      rulesetId(ruleset.id);
      if (typeof ruleset.name !== 'string' || !ruleset.name || /[\x00-\x1f\x7f]/u.test(ruleset.name)) {
        throw new RepositoryError('invalid-data');
      }
      return ruleset;
    }).filter((ruleset) => ruleset.name === managedBranchRulesetName);
  } catch { return { status: 'ambiguous' }; }
  if (named.length === 0) return { status: 'missing' };
  if (named.length !== 1) return { status: 'duplicate' };
  const id = rulesetId(named[0].id);
  return { status: 'found', result: readManagedBranchRuleset(base, id, read, account, options) };
};
const rulesetLookupOutcome = (
  lookup: ReturnType<typeof findManagedBranchRuleset>, presentStatus: 'present' | 'enabled',
): ManagedBranchRulesetOutcome | undefined => {
  if (lookup.status === 'missing') return undefined;
  if (lookup.status === 'duplicate') return { status: 'ambiguous', reason: 'duplicate' };
  if (lookup.status !== 'found') return { status: lookup.status } as ManagedBranchRulesetOutcome;
  if (lookup.result === 'match') return { status: presentStatus };
  if (lookup.result === 'mismatch') return { status: 'ambiguous', reason: 'mismatch' };
  return { status: lookup.result } as ManagedBranchRulesetOutcome;
};
const ensureManagedBranchRuleset = (
  read: RepositoryRead, options: RepositoryOptions = {},
): ManagedBranchRulesetOutcome => {
  const account = readRepositoryAccount(options);
  if (account.id !== read.destination.ownerId) throw new RepositoryError('identity');
  const existing = rulesetLookupOutcome(findManagedBranchRuleset(read, account, options), 'present');
  if (existing) return existing;
  const endpoint = `repos/${account.login}/${read.destination.name}/rulesets`;
  let creation: ApiResult = { ok: false, body: {} };
  let mutationFailure: RepositoryError | undefined;
  try { creation = api(endpoint, managedBranchRulesetPayload(read.destination.branch), options); } catch (error) {
    if (error instanceof RepositoryError && (['local-io', 'cleanup'].includes(error.problem) || error.cleanupFailed)) {
      mutationFailure = error.cleanupFailed && error.problem !== 'cleanup' ? new RepositoryError('cleanup') : error;
    }
  }
  if (!mutationFailure && !creation.ok) {
    requireCleanTransport(creation);
    const classified = classifyProtectionApiFailure(creation);
    if (classified !== 'ambiguous') return { status: classified };
  }
  let detailResult: ReturnType<typeof readManagedBranchRuleset> | undefined;
  if (!mutationFailure && creation.ok) {
    let id: number | undefined;
    try { id = rulesetId(creation.body.id); } catch { /* Reconcile the ambiguous response below. */ }
    if (id !== undefined) {
      try { detailResult = readManagedBranchRuleset(endpoint, id, read, account, options); } catch (error) {
        if (error instanceof RepositoryError && ['local-io', 'cleanup'].includes(error.problem)) mutationFailure = error;
      }
      if (detailResult === 'match') {
        if (creation.cleanupFailed) {
          writeStderrLine('ballin backup: repository protection confirmed, but transport cleanup is incomplete');
          throw new RepositoryError('cleanup');
        }
        return { status: 'enabled' };
      }
    }
  }
  const confirmation = rulesetLookupOutcome(findManagedBranchRuleset(read, account, options), 'enabled');
  if (confirmation?.status === 'enabled') {
    if (creation.cleanupFailed || mutationFailure?.cleanupFailed || mutationFailure?.problem === 'cleanup'
    ) {
      writeStderrLine('ballin backup: repository protection confirmed, but transport cleanup is incomplete');
      throw new RepositoryError('cleanup');
    }
    if (mutationFailure?.problem === 'local-io') throw mutationFailure;
    return confirmation;
  }
  if (mutationFailure?.problem === 'local-io' || mutationFailure?.problem === 'cleanup') throw mutationFailure;
  if (confirmation) return confirmation;
  if (detailResult === 'permission-denied') return { status: 'permission-denied' };
  if (detailResult === 'mismatch') return { status: 'ambiguous', reason: 'mismatch' };
  if (detailResult === 'unexpected') return { status: 'unexpected' };
  return { status: 'ambiguous', reason: 'unconfirmed' };
};
const publish = (
  before: RepositoryRead, additions: Map<string, Buffer>, initialize: boolean, options: RepositoryOptions,
): RepositoryRead => {
  assertCurrent(before, options);
  const expected = new Map(before.revision.entries.map((entry) => [entry.path, entry.sha]));
  additions.forEach((bytes, name) => expected.set(name, blobOid(bytes)));
  let result: ApiResult = { ok: false, body: {} };
  let transportFailure: RepositoryError | undefined;
  try { result = api('graphql', {
    query: `mutation BallinPublish($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }`,
    variables: { input: {
      branch: { id: before.revision.branchId }, expectedHeadOid: before.revision.head,
      message: { headline: initialize ? 'Initialize Ballin backup' : 'Update Ballin backup' },
      fileChanges: {
        additions: [...additions].map(([name, bytes]) => ({ path: name, contents: bytes.toString('base64') })),
      },
    } },
  }, options); } catch (error) {
    // Confirm possible remote effects, but cleanup failure must remain fatal.
    if (error instanceof RepositoryError && error.cleanupFailed) transportFailure = error;
  }
  const errors = result.body.errors;
  const data = isConfigObject(result.body.data) ? result.body.data as Record<string, unknown> : {};
  if (Array.isArray(errors) && errors.length && errors.every((error) => (
    isConfigObject(error) && ['FORBIDDEN', 'NOT_FOUND', 'STALE_DATA', 'UNPROCESSABLE'].includes(error.type as string)
  )) && !data.createCommitOnBranch) throw new RepositoryError('rejected');
  // A missing response/commit ID is not evidence of failure: confirm state once, never retry the mutation.
  const mutation = isConfigObject(data.createCommitOnBranch) ? data.createCommitOnBranch as Record<string, unknown> : {};
  const returnedCommit = isConfigObject(mutation.commit) ? (mutation.commit as Record<string, unknown>).oid : undefined;
  const confirmation = inspectRepository(before.destination, options);
  if (confirmation.status !== 'complete') throw new RepositoryError('uncertain');
  const after = confirmation.read;
  if (
    (returnedCommit !== undefined && returnedCommit !== after.revision.head)
    || after.revision.parents.length !== 1 || after.revision.parents[0] !== before.revision.head
    || after.revision.entries.length !== expected.size
    || after.revision.entries.some((entry) => expected.get(entry.path) !== entry.sha)
    // The tree inventory confirms the README blob ID; its explanatory contents are intentionally not read as backup state.
    || [...additions].some(([name, bytes]) => (
      name !== repositoryReadmeFileName && !after.snapshots.get(name)?.equals(bytes)
    ))
  ) throw new RepositoryError('uncertain');
  if (result.cleanupFailed || transportFailure) {
    writeStderrLine('ballin backup: repository publication confirmed, but transport cleanup is incomplete; cache contents were not advanced');
    throw transportFailure ?? new RepositoryError('cleanup');
  }
  return after;
};
const publishRepositorySnapshots = (
  before: RepositoryRead, additions: Map<string, Buffer>, options: RepositoryOptions = {},
): RepositoryRead => {
  if ([...additions.keys()].some((name) => classifySnapshotFileName(name) !== 'current')) throw new RepositoryError('unsupported');
  if (additions.size === 0) { assertCurrent(before, options); return before; }
  return publish(before, additions, false, options);
};
const createRepositoryBackup = (name: string, account: Account, options: RepositoryOptions = {}): RepositoryRead => {
  if (!validRepositoryName(name)) throw new RepositoryError('invalid-data');
  // Confirm the effective account immediately before creating under /user.
  if (readRepositoryAccount(options).id !== account.id) throw new RepositoryError('identity');
  const result = api('user/repos', { name, private: true, auto_init: true }, options);
  if (!result.ok) throw new RepositoryError('uncertain');
  if (object(result.body.owner).node_id !== account.id || result.body.private !== true || result.body.name !== name) {
    throw new RepositoryError('identity');
  }
  const destination = {
    id: identifier(result.body.node_id), ownerId: account.id, name, branch: identifier(result.body.default_branch),
  };
  try {
    requireCleanTransport(result);
    const seed = requireRepositoryRead(inspect(destination, account, options, true));
    return publish(seed, new Map([
      [repositoryMarkerFileName, markerBytes(destination)],
      [repositoryReadmeFileName, repositoryReadmeBytes()],
    ]), true, options);
  } catch (error) {
    const failure = error instanceof RepositoryError ? error : new RepositoryError('uncertain');
    failure.completedStage = 'repository-created';
    throw failure;
  }
};
const repositoryCacheDirectory = (root: string, destination: RepositoryDestination): string => path.join(root,
  crypto.createHash('sha256').update(JSON.stringify(['github.com', destination.ownerId, destination.id, destination.branch])).digest('hex'));
const repositoryUrl = (destination: RepositoryDestination, account: Account): string => {
  if (destination.ownerId !== account.id) throw new RepositoryError('identity');
  return `https://github.com/${account.login}/${destination.name}`;
};

module.exports = {
  RepositoryError, repositoryMessages, readRepositoryAccount, candidateRepository, inspectRepository,
  requireRepositoryRead, sameRepositoryRevision, unexpectedRepositoryEntries,
  createRepositoryBackup, ensureManagedBranchRuleset, publishRepositorySnapshots,
  repositoryCacheDirectory, repositoryUrl, repositoryReadmeContents, managedBranchRulesetName,
};
export type {
  RepositoryRead, RepositoryInspection, RepositoryOptions, RepositoryProblem, RepositoryError, Account,
  ManagedBranchRulesetOutcome,
};
