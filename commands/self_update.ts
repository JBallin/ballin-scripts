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

function runSelfUpdateCommand(): void {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');
  const previousSources = sourceDefinitionOid(repoDir);

  if (!updateInstalledRepo(repoDir)) {
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
    writeStdoutLine('Ballin updated.');
    const currentSources = sourceDefinitionOid(repoDir);
    if (!previousSources || !currentSources || previousSources !== currentSources) {
      writeStdoutLine(`Backup source definitions may have changed. Sensitive-source opt-in covers current and future supported sources. Review: ${sourcesUrl}`);
    }
  }
}

module.exports = {
  runSelfUpdateCommand,
};
