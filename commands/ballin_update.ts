const path = require('path');
const {
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const runQuiet = (command: string, args: string[], cwd: string): number | null => (
  runCommand(command, args, {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    stdio: 'ignore',
  }).status
);

const runBallinUpdateCli = (): void => {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');

  writeStdoutLine('👟 getting fresh kicks...');

  if (runQuiet('git', ['fetch'], repoDir) !== 0) {
    writeStdoutLine('git fetch failed');
    process.exitCode = 1;
    return;
  }

  if (runQuiet('git', ['merge'], repoDir) !== 0) {
    writeStdoutLine('git merge failed. stashing changes and trying again...');
    const recovered = runQuiet('git', ['add', '.'], repoDir) === 0
      && runQuiet('git', ['stash'], repoDir) === 0
      && runQuiet('git', ['checkout', 'main'], repoDir) === 0
      && runQuiet('git', ['merge'], repoDir) === 0;

    if (!recovered) {
      writeStdoutLine('git merge failed again.');
      process.exitCode = 1;
      return;
    }
  }

  writeStdoutLine();
  const installResult = runCommand('./install.sh', [], {
    cwd: repoDir,
    env: {
      ...process.env,
      PWD: repoDir,
    },
    stdio: 'inherit',
  });
  process.exitCode = installResult.status ?? 1;
};

module.exports = {
  runBallinUpdateCli,
};
