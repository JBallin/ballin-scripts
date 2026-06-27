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

const runGitOutput = (args: string[], cwd: string): string | null => {
  const result = runCommand('git', args, {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
};

const runFetch = (branch: string, cwd: string): number | null => (
  runCommand('git', ['fetch', 'origin', `+${branch}:refs/remotes/origin/${branch}`], {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
    },
    stdio: ['inherit', 'ignore', 'inherit'],
  }).status
);

const getCurrentBranch = (cwd: string): string | null => {
  const branch = runGitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch || branch === 'HEAD') {
    return null;
  }

  return branch;
};

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

  const branch = getCurrentBranch(repoDir);
  if (!branch) {
    writeStdoutLine('git current branch lookup failed');
    process.exitCode = 1;
    return;
  }

  const remoteRef = `origin/${branch}`;
  if (runFetch(branch, repoDir) !== 0) {
    writeStdoutLine(`git fetch origin ${branch} failed`);
    process.exitCode = 1;
    return;
  }

  if (runGitQuiet(['merge', remoteRef], repoDir) !== 0) {
    writeStdoutLine('git merge failed. stashing changes and trying again...');

    if (runGitQuiet(['stash', 'push', '--include-untracked'], repoDir) !== 0) {
      writeStdoutLine('git stash failed during merge recovery.');
      process.exitCode = 1;
      return;
    }

    if (runGitQuiet(['checkout', branch], repoDir) !== 0) {
      writeStdoutLine('git checkout failed during merge recovery.');
      process.exitCode = 1;
      return;
    }

    if (runGitQuiet(['merge', remoteRef], repoDir) !== 0) {
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
