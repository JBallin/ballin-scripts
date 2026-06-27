const path = require('path');
const {
  isDirectory,
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

const isMergeInProgress = (cwd: string): boolean => (
  runGitQuiet(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd) === 0
);

const stashChanges = (repoDir: string, recoveryContext: string): boolean => {
  if (isMergeInProgress(repoDir) && runGitQuiet(['merge', '--abort'], repoDir) !== 0) {
    writeStdoutLine(`git merge abort failed during ${recoveryContext}.`);
    return false;
  }

  if (runGitQuiet(['stash', 'push', '--include-untracked'], repoDir) !== 0) {
    writeStdoutLine(`git stash failed during ${recoveryContext}.`);
    return false;
  }

  return true;
};

const checkoutUpdateBranch = (repoDir: string): boolean => {
  if (runGitQuiet(['checkout', updateBranch], repoDir) === 0) {
    return true;
  }

  writeStdoutLine(`git checkout ${updateBranch} failed. stashing changes and trying again...`);

  if (!stashChanges(repoDir, 'checkout recovery')) {
    return false;
  }

  if (runGitQuiet(['checkout', updateBranch], repoDir) !== 0) {
    writeStdoutLine('git checkout failed during checkout recovery.');
    return false;
  }

  return true;
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

  if (!checkoutUpdateBranch(repoDir)) {
    process.exitCode = 1;
    return;
  }

  if (runGitQuiet(['merge', updateRemoteRef], repoDir) !== 0) {
    writeStdoutLine('git merge failed. stashing changes and trying again...');

    if (!stashChanges(repoDir, 'merge recovery')) {
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
