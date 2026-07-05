const path = require('path');
const {
  rethrowCommandError,
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

function runSelfUpdateCommand(): void {
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

const runSelfUpdateCli = (): void => {
  void runWithCommandAnalytics('ballin self-update', runSelfUpdateCommand).catch(rethrowCommandError);
};

module.exports = {
  runSelfUpdateCommand,
  runSelfUpdateCli,
};
