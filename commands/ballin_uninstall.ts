const fs = require('fs');
const path = require('path');
const {
  commandExists,
  readCommandOutput,
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const addUnique = (items: string[], candidate: string): void => {
  if (!items.includes(candidate)) {
    items.push(candidate);
  }
};

const removeOwnedLink = (linkPath: string, targetPath: string): void => {
  if (!fs.existsSync(linkPath)) {
    return;
  }

  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    return;
  }

  const readlinkOutput = readCommandOutput('readlink', [linkPath]);
  if (readlinkOutput?.trimEnd() === targetPath) {
    runCommand('rm', [linkPath], { stdio: 'inherit' });
  }
};

const runBallinUninstallCli = (): void => {
  const homeDir = process.env.HOME ?? '';
  const repoDir = path.join(homeDir, '.ballin-scripts');
  const systemRoot = process.env.BALLIN_UNINSTALL_TEST_SYSTEM_ROOT ?? '';
  const binDirs = [
    path.join(homeDir, '.local', 'bin'),
    path.join(systemRoot, 'usr', 'local', 'bin'),
    path.join(systemRoot, 'opt', 'homebrew', 'bin'),
  ];

  writeStdoutLine();
  writeStdoutLine("It's been real...");

  if (commandExists('brew')) {
    const brewPrefix = readCommandOutput('brew', ['--prefix'])?.trim();
    if (brewPrefix) {
      const relocatedPrefix = ['/usr/local', '/opt/homebrew'].includes(brewPrefix)
        ? `${systemRoot}${brewPrefix}`
        : brewPrefix;
      addUnique(binDirs, path.join(relocatedPrefix, 'bin'));
    }
  }

  const repoBinDir = path.join(repoDir, 'bin');
  if (fs.existsSync(repoBinDir)) {
    fs.readdirSync(repoBinDir).forEach((binName: string) => {
      const targetPath = path.join(repoBinDir, binName);
      binDirs.forEach((binDir) => {
        removeOwnedLink(path.join(binDir, binName), targetPath);
      });
    });
  }

  writeStdoutLine('Deleted symlinked binaries');
  runCommand('rm', ['-rf', repoDir], { stdio: 'inherit' });
  writeStdoutLine('PEACE! You still ballin tho...');
  writeStdoutLine();
};

module.exports = {
  runBallinUninstallCli,
};
