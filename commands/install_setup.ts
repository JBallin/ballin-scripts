const fs = require('fs');
const path = require('path');
const {
  commandExists,
  runCommand,
  writeStdoutLine,
} = require('./commandHelpers.ts');

const backupMarker = '### Backup of your dev environment\n'
  + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n'
  + '\n';

let inputLines: string[] | null = null;

const readPrompt = (prompt: string): string => {
  process.stdout.write(prompt);

  if (inputLines === null) {
    inputLines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  }

  const lines = inputLines as string[];
  return lines.shift() ?? '';
};

const configure = (repoDir: string, docsUrl: string): boolean => {
  const configPath = path.join(repoDir, 'ballin.config.json');
  const defaultConfigPath = path.join(repoDir, 'config', '.defaultConfig.json');
  const updateConfigPath = path.join(repoDir, 'config', 'updateConfig.ts');

  if (!fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(defaultConfigPath, configPath);
    } catch {
      return false;
    }
    writeStdoutLine("\n🧠 Created 'ballin.config.json' file in root using default settings");
    return true;
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: path.join(repoDir, 'config'),
  };
  delete childEnv.BALLIN_TEST_CONFIG_PATH;

  const updateResult = runCommand(process.execPath, [updateConfigPath], {
    cwd: path.join(repoDir, 'config'),
    env: childEnv,
  });

  if (updateResult.stderr) {
    process.stderr.write(updateResult.stderr);
  }

  if (updateResult.status !== 0 || updateResult.error) {
    return false;
  }

  const updateOutput = updateResult.stdout.trimEnd();
  if (updateOutput) {
    writeStdoutLine(`\n🙌 ${updateOutput}`);
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  return true;
};

const configValue = (ballinConfig: string, key: string): string | null => {
  const result = runCommand(ballinConfig, ['get', key]);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.trimEnd();
};

const setConfigValue = (ballinConfig: string, key: string, value: string): boolean => {
  const result = runCommand(ballinConfig, ['set', key, value]);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status === 0 && !result.error;
};

const runGh = (
  host: string,
  args: string[],
  options: { cwd: string; suppressStderr?: boolean } = { cwd: process.cwd() },
) => runCommand('gh', args, {
  cwd: options.cwd,
  env: {
    ...process.env,
    GH_HOST: host,
  },
});

const restoreAdoptedConfig = (
  repoDir: string,
  docsUrl: string,
  host: string,
  gistId: string,
): boolean => {
  const restoreConfig = path.join(repoDir, '.ballin.config.restore.tmp');
  const previousConfig = path.join(repoDir, '.ballin.config.restore.previous.tmp');
  const configPath = path.join(repoDir, 'ballin.config.json');

  fs.copyFileSync(configPath, previousConfig);

  const gistResult = runGh(host, ['gist', 'view', gistId, '--raw', '--filename', 'ballin_config'], {
    cwd: repoDir,
  });
  if (gistResult.stderr) {
    process.stderr.write(gistResult.stderr);
  }

  if (gistResult.status !== 0 || gistResult.error) {
    writeStdoutLine('\nℹ️  No ballin_config snapshot was found in that gist; keeping the local config defaults.');
    fs.rmSync(restoreConfig, { force: true });
    fs.rmSync(previousConfig, { force: true });
    return true;
  }

  fs.writeFileSync(restoreConfig, gistResult.stdout);
  fs.copyFileSync(restoreConfig, configPath);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: path.join(repoDir, 'config'),
  };
  delete childEnv.BALLIN_TEST_CONFIG_PATH;

  const updateResult = runCommand(process.execPath, [path.join(repoDir, 'config', 'updateConfig.ts')], {
    cwd: repoDir,
    env: childEnv,
  });
  if (updateResult.stderr) {
    process.stderr.write(updateResult.stderr);
  }

  if (updateResult.status !== 0 || updateResult.error) {
    fs.copyFileSync(previousConfig, configPath);
    fs.rmSync(restoreConfig, { force: true });
    fs.rmSync(previousConfig, { force: true });
    return false;
  }

  writeStdoutLine('\n♻️  Restored ballin.config.json from your backup gist.');
  const updateOutput = updateResult.stdout.trimEnd();
  if (updateOutput) {
    writeStdoutLine(`\n🙌 ${updateOutput}`);
    writeStdoutLine(`\n👀 Docs: ${docsUrl}`);
  }

  fs.rmSync(restoreConfig, { force: true });
  fs.rmSync(previousConfig, { force: true });
  return true;
};

const configureGist = (repoDir: string, docsUrl: string, guHostExisted: boolean): boolean => {
  const ballinConfig = path.join(repoDir, 'bin', 'ballin_config');
  let guHost = configValue(ballinConfig, 'gu.host');
  let guId = configValue(ballinConfig, 'gu.id');

  if (guHost === null || guId === null) {
    return false;
  }

  if (process.env.BALLIN_GU_HOST) {
    if (!setConfigValue(ballinConfig, 'gu.host', process.env.BALLIN_GU_HOST)) {
      return false;
    }
    guHost = configValue(ballinConfig, 'gu.host');
    if (guHost === null) {
      return false;
    }
  } else if (guId === 'null' || !guHostExisted) {
    const inputHost = readPrompt(`\n🤔 What GitHub host should be used for Gist backups? [${guHost}] `);
    if (inputHost) {
      if (!setConfigValue(ballinConfig, 'gu.host', inputHost)) {
        return false;
      }
      guHost = configValue(ballinConfig, 'gu.host');
      if (guHost === null) {
        return false;
      }
    }
  }

  if (!commandExists('gh')) {
    writeStdoutLine('\n⚠️  ERROR: GitHub CLI is required for Gist backup setup.');
    writeStdoutLine('\nInstall gh, authenticate it, then run this installer again.');
    writeStdoutLine(`\nSetup guide: ${docsUrl}`);
    writeStdoutLine(`\nRun after installing gh:\n  gh auth login --hostname ${guHost}`);
    return false;
  }

  const authResult = runCommand('gh', ['auth', 'status', '--hostname', guHost], {
    cwd: repoDir,
    env: {
      ...process.env,
      GH_HOST: guHost,
    },
  });

  if (authResult.status !== 0 || authResult.error) {
    writeStdoutLine(`\n⚠️  ERROR: gh is not authenticated for ${guHost}.`);
    writeStdoutLine(`\nRun:\n  gh auth login --hostname ${guHost}`);
    writeStdoutLine('\nThen run this installer again.');
    return false;
  }

  if (guId !== 'null') {
    return true;
  }

  const hasBackup = readPrompt('\n🤔 Do you already have a ballin-scripts backup gist? [y/N] ');
  if (hasBackup === 'y' || hasBackup === 'Y') {
    writeStdoutLine('\nWelcome Back!');
    let validGistId = false;
    while (!validGistId) {
      const gistId = readPrompt('Enter your gist ID: ');
      const markerResult = runGh(guHost, ['gist', 'view', gistId, '--raw', '--filename', '.MyConfig.md'], {
        cwd: repoDir,
      });

      if (markerResult.status === 0 && markerResult.stdout === backupMarker) {
        writeStdoutLine('\n👍 Storing your previous gist ID in your config:');
        if (!restoreAdoptedConfig(repoDir, docsUrl, guHost, gistId)) {
          return false;
        }
        if (!setConfigValue(ballinConfig, 'gu.id', gistId)) {
          return false;
        }
        validGistId = true;
      } else {
        writeStdoutLine(`\n⚠️  INVALID: Expected backup marker in gist '${gistId}'.`);
      }
    }
  }

  guId = configValue(ballinConfig, 'gu.id');
  if (guId === null) {
    return false;
  }

  if (guId === 'null') {
    const markerPath = path.join(repoDir, '.MyConfig.md');
    fs.writeFileSync(markerPath, backupMarker);

    try {
      const createResult = runGh(guHost, ['gist', 'create', '.MyConfig.md', '--desc', backupMarker], {
        cwd: repoDir,
      });
      if (createResult.stderr) {
        process.stderr.write(createResult.stderr);
      }
      if (createResult.status !== 0 || createResult.error) {
        return false;
      }

      const gistUrl = createResult.stdout.trimEnd();
      writeStdoutLine(`\n💥 Created a secret gist titled '.MyConfig' at the following URL:\n${gistUrl}`);

      const createdGistId = gistUrl.split('/').pop() ?? gistUrl;
      writeStdoutLine('\n🧳 Storing your new gist ID in your config...');
      if (!setConfigValue(ballinConfig, 'gu.id', createdGistId)) {
        return false;
      }

      const guCacheDir = path.join(repoDir, '.gu-cache');
      if (fs.existsSync(guCacheDir) && fs.statSync(guCacheDir).isDirectory()) {
        fs.rmSync(guCacheDir, { recursive: true, force: true });
        writeStdoutLine('\n🗑  Deleted existing .gu-cache folder');
      }
    } finally {
      fs.rmSync(markerPath, { force: true });
    }
  }

  return true;
};

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
  const [, , command, repoDir, option] = process.argv;

  if (command === 'configure' && repoDir && option) {
    process.exitCode = configure(repoDir, option) ? 0 : 1;
    return;
  }

  if (command === 'gist' && repoDir && option) {
    const guHostExisted = process.argv[5] === 'true';
    process.exitCode = configureGist(repoDir, option, guHostExisted) ? 0 : 1;
    return;
  }

  if (command === 'symlink-binaries' && repoDir && option) {
    process.exitCode = symlinkBinaries(repoDir, option) ? 0 : 1;
    return;
  }

  if (!command || !repoDir || !option) {
    writeStdoutLine('Usage: install_setup.ts <configure|gist|symlink-binaries> <repo-dir> <docs-url|bin-dir> [gu-host-existed]');
    process.exitCode = 1;
    return;
  }

  writeStdoutLine(`Unknown install setup command: ${command}`);
  process.exitCode = 1;
};

if (require.main === module) {
  runInstallSetupCli();
}

module.exports = {
  configure,
  configureGist,
  runInstallSetupCli,
  symlinkBinaries,
};
