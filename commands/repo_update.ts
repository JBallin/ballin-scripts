const {
  isDirectory,
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

import type { StdioOptions } from 'child_process';

const updateBranch = 'main';
const updateRemoteRef = `origin/${updateBranch}`;

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

const updateInstalledRepo = (repoDir: string): boolean => {
  if (!isDirectory(repoDir)) {
    writeStdoutLine(`install directory not found: ${repoDir}`);
    return false;
  }

  if (runFetch(repoDir) !== 0) {
    writeStdoutLine(`git fetch origin ${updateBranch} failed`);
    return false;
  }

  if (!checkoutUpdateBranch(repoDir)) {
    return false;
  }

  if (runGitQuiet(['merge', updateRemoteRef], repoDir) !== 0) {
    writeStdoutLine('git merge failed. stashing changes and trying again...');

    if (!stashChanges(repoDir, 'merge recovery')) {
      return false;
    }

    if (runGitQuiet(['checkout', updateBranch], repoDir) !== 0) {
      writeStdoutLine('git checkout failed during merge recovery.');
      return false;
    }

    if (runGitQuiet(['merge', updateRemoteRef], repoDir) !== 0) {
      writeStdoutLine('git merge failed during merge recovery.');
      return false;
    }
  }

  return true;
};

const runRepoUpdateCli = (): void => {
  const [, , repoDir] = process.argv;

  if (!repoDir) {
    writeStdoutLine('Usage: repo_update.ts <repo-dir>');
    process.exitCode = 1;
    return;
  }

  process.exitCode = updateInstalledRepo(repoDir) ? 0 : 1;
};

if (require.main === module) {
  runRepoUpdateCli();
}

module.exports = {
  commandEnv,
  runRepoUpdateCli,
  updateInstalledRepo,
};
