const path = require('path');
const {
  runCommand,
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  commandEnv,
  updateInstalledRepo,
} = require('./repo_update.ts');

const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const sourcesUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md';

const localGit = (repoDir: string, args: string[]) => runCommand('git', args, {
  cwd: repoDir, env: { ...commandEnv(repoDir), GIT_NO_LAZY_FETCH: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});
const localGitOutput = (repoDir: string, args: string[]): string | undefined => {
  try {
    const result = localGit(repoDir, args);
    return result.status === 0 && !result.error && !result.signal ? result.stdout?.trim() : undefined;
  } catch { return undefined; }
};
// Compare data only: never load or execute source from either Git revision.
const canonicalScope = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalScope).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalScope(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const scopeObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const scopeString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const scopeStrings = (value: unknown, minimum = 0): value is string[] => (
  Array.isArray(value) && value.length >= minimum && value.every(scopeString)
);
const scopeFields = (value: Record<string, unknown>, keys: string[]): boolean => keys.every((key) => scopeString(value[key]));
const scopeCategories = {
  shell: true, 'bash-completions': true, homebrew: true, git: true, npm: true,
  python: true, node: true, vscode: true, 'vscode-insiders': true, editor: true,
  ballin: true, mas: true, codex: true, claude: true,
} satisfies Record<import('./backup_snapshots.ts').SnapshotCategory, true>;
const scopeSource = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  switch (value[0]) {
    case 'file':
    case 'command':
      return Object.hasOwn(scopeCategories, value[1]) && value.length === (value[0] === 'file' ? 5 : 6) && value.every(scopeString)
        && ['inventory', 'sensitive', 'preferences'].includes(value[2]);
    case 'editor-file':
    case 'editor-extensions':
      return Object.hasOwn(scopeCategories, value[1]) && value.length === 5 && value.every(scopeString);
    case 'configuration':
      return value.length === 8 && value.slice(0, 4).every(scopeString)
        && ['codex', 'claude'].includes(value[1]) && value.slice(4).every((flag) => typeof flag === 'boolean');
    case 'bash-completions':
    case 'preferences': return value.length === 1;
    default: return false;
  }
};
const validScope = (value: unknown): value is typeof import('./backup_scope.json') => {
  if (!scopeObject(value) || typeof value.collectionPolicy !== 'number'
    || !Number.isSafeInteger(value.collectionPolicy) || value.collectionPolicy < 1
    || !Array.isArray(value.sources) || !value.sources.every(scopeSource)
    || !scopeStrings(value.portableUpdateKeys)) return false;
  const { roots, recursive, preferences, bashCompletions } = value;
  return scopeObject(roots) && scopeStrings(roots.editor, 1)
    && scopeFields(roots, ['editorUser', 'codex', 'claude', 'codexEnvironment', 'claudeEnvironment'])
    && scopeObject(recursive)
    && scopeFields(recursive, ['skillsExcludedRoot', 'profilesPattern', 'markdownSuffix', 'claudeSyncRoot',
      'claudeExcludedRootPrefix', 'claudePluginMarker', 'claudeSkillMarker', 'claudeSyncedOrigin'])
    && scopeStrings(recursive.skillsExcludedSidecar) && recursive.skillsExcludedSidecar.length === 2
    && ['excludedNames', 'claudeSyncBookkeeping', 'claudeExcludedRoots'].every((key) => scopeStrings(recursive[key]))
    && scopeObject(preferences) && scopeString(preferences.name) && scopeStrings(preferences.path, 1)
    && scopeObject(bashCompletions) && scopeFields(bashCompletions, ['name', 'environment'])
    && scopeStrings(bashCompletions.path, 1);
};
const installedScope = (repoDir: string): string | undefined => {
  try {
    const contents = localGitOutput(repoDir, ['show', 'HEAD:commands/backup_scope.json']);
    if (!contents) return undefined;
    const scope = JSON.parse(contents);
    if (!validScope(scope)) return undefined;
    // A selector with valid string shape can still be an unusable expression.
    new RegExp(scope.recursive.profilesPattern, 'u');
    // Catalog order and set ordering do not change what can be collected.
    const sources = scope.sources.map(canonicalScope).sort();
    scope.portableUpdateKeys.sort();
    for (const key of ['excludedNames', 'claudeSyncBookkeeping', 'claudeExcludedRoots']) {
      scope.recursive[key as 'excludedNames' | 'claudeSyncBookkeeping' | 'claudeExcludedRoots'].sort();
    }
    return canonicalScope({ ...scope, sources });
  } catch { return undefined; }
};
const sensitiveSourcesEnabled = (repoDir: string): boolean => {
  const { createConfigStore } = require('../config/store.ts');
  const value = createConfigStore({
    configPath: process.env.BALLIN_TEST_CONFIG_PATH || path.join(repoDir, 'ballin.config.json'),
  }).readLeafValue('backup.includeSensitive');
  return value === true || value === 'true';
};
const installedRevision = (repoDir: string): string | undefined => {
  const oid = localGitOutput(repoDir, ['rev-parse', '--verify', 'HEAD']);
  return oid && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid) ? oid : undefined;
};
const newCommitCount = (repoDir: string, before: string, after: string): number | undefined => {
  try {
    // Incomplete history can silently undercount; optional feedback must stay local.
    if (localGitOutput(repoDir, ['rev-parse', '--is-shallow-repository']) !== 'false') return undefined;
    const partial = localGit(repoDir, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']);
    if (partial.status !== 1 || partial.error || partial.signal) return undefined;
    const ancestry = localGit(repoDir, ['merge-base', '--is-ancestor', before, after]);
    if (ancestry.status !== 0 || ancestry.error || ancestry.signal) return undefined;
    const value = localGitOutput(repoDir, ['rev-list', '--count', `${before}..${after}`]);
    const count = value && /^[1-9]\d*$/u.test(value) ? Number(value) : undefined;
    return Number.isSafeInteger(count) ? count : undefined;
  } catch { return undefined; }
};
const updateResult = (repoDir: string, before: string | undefined): string => {
  try {
    const after = installedRevision(repoDir);
    if (!before || !after) return 'Ballin updated.';
    if (before === after) return 'Ballin is already up to date.';
    const shortBefore = localGitOutput(repoDir, ['rev-parse', '--short=7', '--verify', before]);
    const shortAfter = localGitOutput(repoDir, ['rev-parse', '--short=7', '--verify', after]);
    if (!shortBefore || !shortAfter || !/^[a-f0-9]{7,64}$/u.test(shortBefore)
      || !/^[a-f0-9]{7,64}$/u.test(shortAfter) || !before.startsWith(shortBefore) || !after.startsWith(shortAfter)) {
      return 'Ballin updated.';
    }
    const count = newCommitCount(repoDir, before, after);
    const suffix = count === undefined ? '' : ` (${count} new commit${count === 1 ? '' : 's'})`;
    return `Ballin updated: ${shortBefore} to ${shortAfter}${suffix}.`;
  } catch { return 'Ballin updated.'; }
};

const refreshInstalledBallin = (): void => {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');
  writeStdoutLine('Updating Ballin...');
  const previousSources = installedScope(repoDir);
  const previousRevision = installedRevision(repoDir);

  if (!updateInstalledRepo(repoDir, { quietFetch: true })) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = runVisibleCommand(process.execPath, [
    'commands/install_setup.ts',
    'setup',
    repoDir,
    docsUrl,
    analyticsDocsUrl,
    'self-update',
  ], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  });
  if (process.exitCode === 0) {
    writeStdoutLine(updateResult(repoDir, previousRevision));
    const currentSources = installedScope(repoDir);
    if (!previousSources || !currentSources || previousSources !== currentSources) {
      writeStdoutLine(previousSources && currentSources
        ? 'Supported backup sources or collection scope changed.'
        : 'Unable to compare backup sources and collection scope across this update.');
      if (sensitiveSourcesEnabled(repoDir)) {
        writeStdoutLine('Your sensitive-source opt-in remains enabled across updates and covers current and future supported sources.');
      }
      writeStdoutLine(`Review: ${sourcesUrl}`);
    }
  }
};

function runSelfUpdateCommand(): void {
  refreshInstalledBallin();
}

module.exports = {
  runSelfUpdateCommand,
};
