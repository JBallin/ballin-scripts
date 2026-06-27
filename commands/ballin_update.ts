const fs = require('fs');
const path = require('path');
const {
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const runGitQuiet = (args: string[], cwd: string): number | null => (
  runCommand('git', args, {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    stdio: 'ignore',
  }).status
);

const updateBranch = 'main';
const updateRemoteRef = `origin/${updateBranch}`;

const runFetch = (cwd: string): number | null => (
  runCommand('git', ['fetch', 'origin', `+${updateBranch}:refs/remotes/origin/${updateBranch}`], {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    stdio: ['inherit', 'ignore', 'inherit'],
  }).status
);

const isDirectory = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const runBallinUpdateCli = (): void => {
  const repoDir = path.join(process.env.HOME ?? '', '.ballin-scripts');

  writeStdoutLine('👟 getting fresh kicks...');

  if (!isDirectory(repoDir)) {
    writeStdoutLine(`install directory not found: ${repoDir}`);
    process.exitCode = 1;
    return;
  }

  if (runFetch(repoDir) !== 0) {
    writeStdoutLine(`git fetch origin ${updateBranch} failed`);
    process.exitCode = 1;
    return;
  }

  if (runGitQuiet(['merge', updateRemoteRef], repoDir) !== 0) {
    writeStdoutLine('git merge failed. stashing changes and trying again...');

    if (runGitQuiet(['stash', 'push', '--include-untracked'], repoDir) !== 0) {
      writeStdoutLine('git stash failed during merge recovery.');
      process.exitCode = 1;
      return;
    }

    if (runGitQuiet(['checkout', updateBranch], repoDir) !== 0) {
      writeStdoutLine('git checkout failed during merge recovery.');
      process.exitCode = 1;
      return;
    }

    if (runGitQuiet(['merge', updateRemoteRef], repoDir) !== 0) {
      writeStdoutLine('git merge failed during merge recovery.');
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
