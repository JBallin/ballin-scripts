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

const removeOwnedLink = (linkPath: string, targetPath: string): string | null => {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    return null;
  }

  if (!stat.isSymbolicLink()) {
    return null;
  }

  if (fs.readlinkSync(linkPath) === targetPath) {
    try {
      fs.unlinkSync(linkPath);
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`);
      }
      return linkPath;
    }
  }

  return null;
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
        const remainingLink = removeOwnedLink(path.join(binDir, binName), targetPath);
        if (remainingLink) {
          addUnique(remainingOwnedLinks, remainingLink);
        }
      });
    });
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  if (remainingOwnedLinks.length > 0) {
    writeStdoutLine('Removed the local checkout, but some symlinked binaries remain.');
    process.stderr.write('Uninstall incomplete: these Ballin-owned links remain:\n');
    remainingOwnedLinks.forEach((linkPath) => {
      process.stderr.write(`  ${linkPath}\n`);
    });
    process.stderr.write(
      'Remove the listed links with rm. If removal fails because of permissions, '
        + 'rerun rm with elevated permissions (for example, sudo rm).\n',
    );
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
