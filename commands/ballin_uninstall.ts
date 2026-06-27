const fs = require('fs');
const path = require('path');
const {
  commandExists,
  isDirectory,
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

const removeOwnedLink = (linkPath: string, targetPath: string): void => {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    return;
  }

  if (!stat.isSymbolicLink()) {
    return;
  }

  if (fs.readlinkSync(linkPath) === targetPath) {
    try {
      fs.unlinkSync(linkPath);
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`);
      }
    }
  }
};

const runBallinUninstallCli = (): void => {
  const homeDir = process.env.HOME ?? '';
  const repoDir = path.join(homeDir, '.ballin-scripts');
  const systemRoot = process.env.BALLIN_UNINSTALL_TEST_SYSTEM_ROOT ?? '';
  const binDirs = [
    path.join(homeDir, '.local', 'bin'),
    relocateSystemPath(systemRoot, '/usr/local/bin'),
    relocateSystemPath(systemRoot, '/opt/homebrew/bin'),
  ];

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
  if (isDirectory(repoBinDir)) {
    fs.readdirSync(repoBinDir).forEach((binName: string) => {
      const targetPath = path.join(repoBinDir, binName);
      binDirs.forEach((binDir) => {
        removeOwnedLink(path.join(binDir, binName), targetPath);
      });
    });
  }

  writeStdoutLine('Deleted symlinked binaries');
  fs.rmSync(repoDir, { recursive: true, force: true });
  writeStdoutLine('PEACE! You still ballin tho...');
  writeStdoutLine();
};

module.exports = {
  relocateSystemPath,
  runBallinUninstallCli,
};
