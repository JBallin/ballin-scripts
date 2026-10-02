const path = require('path');
const {
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  commandEnv,
  updateInstalledRepo,
} = require('./repo_update.ts');

const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md';
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';

function runSelfUpdateCommand(): void {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');

  const automatic = process.env.BALLIN_AUTOMATIC_SELF_UPDATE === '1';
  if (!automatic) writeStdoutLine('👟 getting fresh kicks...');

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
    'refresh',
    ...(automatic ? ['automatic-update'] : []),
  ], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  });
}

module.exports = {
  runSelfUpdateCommand,
};
