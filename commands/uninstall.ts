const fs = require('fs');
const path = require('path');
const {
  commandExists,
  readCommandOutput,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const addUnique = (items: string[], candidate: string): void => {
  if (!items.includes(candidate)) {
    items.push(candidate);
  }
};

const relocateSystemPath = (systemRoot: string, absolutePath: string): string => (
  systemRoot ? path.join(systemRoot, absolutePath) : absolutePath
);

type OwnedLinkCleanupStatus = 'complete' | 'remaining' | 'unverified';

const isNotFoundError = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

const reportFilesystemError = (error: unknown): void => {
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  }
};

const removeOwnedLink = (linkPath: string, targetPath: string): OwnedLinkCleanupStatus => {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'complete';
    }
    reportFilesystemError(error);
    return 'unverified';
  }

  if (!stat.isSymbolicLink()) {
    return 'complete';
  }

  if (fs.readlinkSync(linkPath) === targetPath) {
    try {
      fs.unlinkSync(linkPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return 'complete';
      }
      reportFilesystemError(error);
      return 'remaining';
    }
  }

  return 'complete';
};

const runUninstallCommand = (): void => {
  const homeDir = process.env.HOME ?? '';
  const repoDir = path.join(homeDir, '.ballin-scripts');
  const systemRoot = process.env.BALLIN_UNINSTALL_TEST_SYSTEM_ROOT ?? '';
  const binDirs = [
    path.join(homeDir, '.local', 'bin'),
    relocateSystemPath(systemRoot, '/usr/local/bin'),
    relocateSystemPath(systemRoot, '/opt/homebrew/bin'),
  ];
  const remainingOwnedLinks: string[] = [];
  const unverifiedLinkPaths: string[] = [];

  writeStdoutLine();
  writeStdoutLine("It's been real...");

  if (commandExists('brew')) {
    const brewPrefix = readCommandOutput('brew', ['--prefix'])?.trim();
    if (brewPrefix) {
      const relocatedPrefix = ['/usr/local', '/opt/homebrew'].includes(brewPrefix)
        ? relocateSystemPath(systemRoot, brewPrefix)
        : brewPrefix;
      addUnique(binDirs, path.join(relocatedPrefix, 'bin'));
    }
  }

  const repoBinDir = path.join(repoDir, 'bin');
  if (fs.existsSync(repoBinDir)) {
    fs.readdirSync(repoBinDir).forEach((binName: string) => {
      const targetPath = path.join(repoBinDir, binName);
      binDirs.forEach((binDir) => {
        const linkPath = path.join(binDir, binName);
        const cleanupStatus = removeOwnedLink(linkPath, targetPath);
        if (cleanupStatus === 'remaining') {
          addUnique(remainingOwnedLinks, linkPath);
        } else if (cleanupStatus === 'unverified') {
          addUnique(unverifiedLinkPaths, linkPath);
        }
      });
    });
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  if (remainingOwnedLinks.length > 0 || unverifiedLinkPaths.length > 0) {
    writeStdoutLine('Removed the local checkout, but symlink cleanup is incomplete.');
    if (remainingOwnedLinks.length > 0) {
      process.stderr.write('Uninstall incomplete: these Ballin-owned links remain:\n');
      remainingOwnedLinks.forEach((linkPath) => {
        process.stderr.write(`  ${linkPath}\n`);
      });
      process.stderr.write(
        'Remove the listed links with rm. If removal fails because of permissions, '
          + 'rerun rm with elevated permissions (for example, sudo rm).\n',
      );
    }
    if (unverifiedLinkPaths.length > 0) {
      process.stderr.write('These candidate Ballin link paths could not be inspected:\n');
      unverifiedLinkPaths.forEach((linkPath) => {
        process.stderr.write(`  ${linkPath}\n`);
      });
      process.stderr.write(
        'Resolve the reported filesystem errors, then inspect these paths before removing anything.\n',
      );
    }
    process.exitCode = 1;
    writeStdoutLine();
    return;
  }

  writeStdoutLine('Deleted symlinked binaries');
  writeStdoutLine('PEACE! You still ballin tho...');
  writeStdoutLine();
};

module.exports = {
  relocateSystemPath,
  runUninstallCommand,
};
