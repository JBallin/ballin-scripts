const fs = require('fs');
const path = require('path');
const {
  writeStdoutLine,
} = require('./commandHelpers.ts');

const symlinkBinaries = (repoDir: string, binDir: string): boolean => {
  const sourceBinDir = path.join(repoDir, 'bin');

  try {
    fs.mkdirSync(binDir, { recursive: true });
  } catch {
    writeStdoutLine(`\n⚠️  ERROR: Unable to create ${binDir}`);
    return false;
  }

  try {
    for (const binName of fs.readdirSync(sourceBinDir)) {
      const sourcePath = path.join(sourceBinDir, binName);
      const targetPath = path.join(binDir, binName);

      fs.rmSync(targetPath, { force: true });
      fs.symlinkSync(sourcePath, targetPath);
    }
  } catch {
    writeStdoutLine(`\n⚠️  ERROR: Unable to symlink binaries into ${binDir}`);
    return false;
  }

  writeStdoutLine(`\n💪 symlinked binaries into ${binDir}`);
  return true;
};

const runInstallSetupCli = (): void => {
  const [, , command, repoDir, binDir] = process.argv;

  if (command !== 'symlink-binaries' || !repoDir || !binDir) {
    writeStdoutLine('Usage: install_setup.ts symlink-binaries <repo-dir> <bin-dir>');
    process.exitCode = 1;
    return;
  }

  process.exitCode = symlinkBinaries(repoDir, binDir) ? 0 : 1;
};

if (require.main === module) {
  runInstallSetupCli();
}

module.exports = {
  runInstallSetupCli,
  symlinkBinaries,
};
