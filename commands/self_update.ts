const path = require('path');
const fs = require('fs');
const {
  runCommand,
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  commandEnv,
  updateInstalledRepo,
} = require('./repo_update.ts');

const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md';
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const sourcesUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md';
const sourceDefinitionOid = (repoDir: string): string | undefined => {
  try {
    if (!fs.statSync(repoDir).isDirectory()) return undefined;
    // Git's blob identity compares the exact file bytes without executing source.
    const result = runCommand('git', ['rev-parse', '--verify', 'HEAD:commands/backup_snapshots.ts'], {
      cwd: repoDir, env: commandEnv(repoDir), stdio: ['ignore', 'pipe', 'ignore'],
    });
    const oid = result.stdout?.trim();
    return result.status === 0 && !result.error && !result.signal && oid && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)
      ? oid : undefined;
  } catch { return undefined; }
};

const localGit = (repoDir: string, args: string[]) => runCommand('git', args, {
  cwd: repoDir, env: { ...commandEnv(repoDir), GIT_NO_LAZY_FETCH: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});
const localGitOutput = (repoDir: string, args: string[]): string | undefined => {
  try {
    const result = localGit(repoDir, args);
    return result.status === 0 && !result.error && !result.signal ? result.stdout?.trim() : undefined;
  } catch { return undefined; }
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
  const previousSources = sourceDefinitionOid(repoDir);
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
    const currentSources = sourceDefinitionOid(repoDir);
    if (!previousSources || !currentSources || previousSources !== currentSources) {
      writeStdoutLine('Backup source definitions may have changed. Sensitive-source opt-in covers current and future supported sources.');
      writeStdoutLine(`Review:\n${sourcesUrl}`);
    }
  }
};

function runSelfUpdateCommand(): void {
  refreshInstalledBallin();
}

module.exports = {
  runSelfUpdateCommand,
};
