const path = require('path');
const {
  runWithCommandAnalytics,
} = require('./analytics.ts');
const {
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');
const {
  commandEnv,
  updateInstalledRepo,
} = require('./repo_update.ts');

const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md';

function runBallinUpdateCommand(): void {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');

  writeStdoutLine('👟 getting fresh kicks...');

  if (!updateInstalledRepo(repoDir)) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = runVisibleCommand(process.execPath, [
    'commands/install_setup.ts',
    'setup',
    repoDir,
    docsUrl,
  ], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  });
}

const runBallinUpdateCli = (): void => {
  void runWithCommandAnalytics('ballin_update', runBallinUpdateCommand);
};

module.exports = {
  runBallinUpdateCli,
};
