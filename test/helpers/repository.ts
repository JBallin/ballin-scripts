const fs = require('fs');
const path = require('path');
const repositoryConstants = () => require('../../commands/backup_repository.ts');

type FixtureCommit = { files: Record<string, string>; parents: string[]; tree: string };
type FixtureRuleset = Record<string, unknown> & { id: number; name: string };
type Request = { endpoint: string; method: string; payload?: { query?: string; variables?: Record<string, unknown>; [key: string]: unknown }; debug?: string; host?: string; environmentHost?: string };
type FixtureState = {
  exists: boolean; host: string; id: string; ownerId: string; login: string; name: string; branch: string; head: string;
  commits: Record<string, FixtureCommit>; requests: Request[]; rulesets: FixtureRuleset[]; nextRulesetId: number;
  faults: Record<string, unknown>;
  featureSettings: Record<string, boolean>;
};
type Response = { status: number; stdout: string; stderr?: string; signal: null };
const runtime = require('./repository-runtime.js') as typeof import('./repository-runtime.js');
const { blobHash, fixtureRuleset, commitFixture, requestFixture, runFixtureCli } = runtime;
const fixtureDestination = { host: 'github.com', id: 'R_fixture', ownerId: 'U_fixture', name: 'ballin-backups', branch: 'main' };
const fixtureMarker = (): string => JSON.stringify({
  format: 'ballin-backup', version: 1, repositoryId: fixtureDestination.id, ownerId: fixtureDestination.ownerId,
}) + '\n';
const fixtureState = (snapshots: Record<string, string> = {}): FixtureState => {
  const state: FixtureState = {
    exists: true, ...fixtureDestination, login: 'fixture-user', head: '', commits: {}, requests: [],
    rulesets: [fixtureRuleset()], nextRulesetId: 2, faults: {},
    featureSettings: { has_issues: true, has_wiki: true, has_projects: true, has_pull_requests: true },
  };
  const files = {
    '.ballin-backup.json': fixtureMarker(),
    'README.md': repositoryConstants().repositoryReadmeContents,
    ...snapshots,
  };
  commitFixture(state, Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value).toString('base64')])), []);
  return state;
};
const installRepositoryFixture = (directory: string, statePath: string, usePathNode = false): void => {
  const helper = path.join(__dirname, 'repository-runtime.js');
  const interpreter = usePathNode ? '/usr/bin/env node' : process.execPath;
  fs.writeFileSync(path.join(directory, 'gh'), `#!${interpreter}\nrequire(${JSON.stringify(helper)}).runFixtureCli(${JSON.stringify(statePath)});\n`, { mode: 0o755 });
};
module.exports = {
  fixtureDestination, fixtureMarker, fixtureRuleset, fixtureState, commitFixture,
  requestFixture, installRepositoryFixture, runFixtureCli, blobHash,
};
export type { FixtureState, FixtureCommit, FixtureRuleset, Request, Response };
