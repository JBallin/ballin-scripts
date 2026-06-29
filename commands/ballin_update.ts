const path = require('path');
const {
  runWithCommandAnalytics,
} = require('./analytics.ts');
const {
  isDirectory,
  runCommand,
  runVisibleCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

import type { StdioOptions } from 'child_process';

const commandEnv = (cwd: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PWD: cwd,
});

const runGit = (args: string[], cwd: string, stdio: StdioOptions): number | null => (
  runCommand('git', args, {
    cwd,
    env: commandEnv(cwd),
    stdio,
  }).status
);

const runGitQuiet = (args: string[], cwd: string): number | null => (
  runGit(args, cwd, 'ignore')
);

const updateBranch = 'main';
const updateRemoteRef = `origin/${updateBranch}`;

const runFetch = (cwd: string): number | null => (
  runGit(
    ['fetch', 'origin', `+${updateBranch}:refs/remotes/origin/${updateBranch}`],
    cwd,
    ['inherit', 'ignore', 'inherit'],
  )
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

function runBallinUpdateCommand(): void {
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
  process.exitCode = runVisibleCommand('./install.sh', [], {
    cwd: repoDir,
    env: commandEnv(repoDir),
  });
}

const runBallinUpdateCli = (): void => {
  runWithCommandAnalytics('ballin_update', runBallinUpdateCommand);
};

module.exports = {
  runBallinUpdateCli,
};
