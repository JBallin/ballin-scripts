const fs = require('fs');
const path = require('path');
const {
  commandExists,
  progress,
  readCommandOutput,
  runCommand,
  writeStderrLine,
} = require('./commandHelpers.ts');

const configValue = (key: string): string => (
  readCommandOutput('ballin_config', ['get', key])?.trim() ?? ''
);

const runVisible = (command: string, args: string[] = [], env = process.env): number | null => (
  runCommand(command, args, { env, stdio: 'inherit' }).status
);

const runUpCli = (): void => {
  if (commandExists('brew')) {
    progress('Updating Homebrew packages');
    const brewEnv = {
      ...process.env,
      HOMEBREW_NO_ENV_HINTS: '1',
      HOMEBREW_NO_ASK: '1',
    };
    runVisible('brew', ['upgrade'], brewEnv);

    if (configValue('up.cleanup') === 'true') {
      progress('Cleaning up Homebrew packages');
      runVisible('brew', ['cleanup'], brewEnv);
    }

    progress('Checking Homebrew installation');
    runVisible('brew', ['doctor'], brewEnv);
  }

  if (configValue('up.nvm') === 'true') {
    progress('Updating Node.js LTS');
    const nvmDir = process.env.NVM_DIR ?? '';
    const nvmScript = path.join(nvmDir, 'nvm.sh');
    if (nvmDir && fs.existsSync(nvmScript) && fs.statSync(nvmScript).size > 0) {
      runCommand('bash', ['-c', '. "$NVM_DIR/nvm.sh"; nvm install --lts'], {
        env: process.env,
        stdio: 'inherit',
      });
    } else {
      writeStderrLine();
      writeStderrLine('⚠️  Skipping Node.js LTS update: unable to load nvm.');
      writeStderrLine('Set NVM_DIR to your nvm installation or disable this update with: ballin_config set up.nvm false');
    }
  }

  if (commandExists('npm') && configValue('up.npm') === 'true') {
    progress('Updating global npm packages');
    runVisible('npm', ['update', '-g']);
  }

  if (commandExists('mas')) {
    progress('Updating App Store apps');
    runVisible('mas', ['upgrade']);
  }

  if (commandExists('softwareupdate') && configValue('up.softwareupdate') === 'true') {
    progress('Installing macOS updates');
    runVisible('softwareupdate', ['-ia']);
  }

  if (configValue('up.ballin') === 'true') {
    progress('Updating ballin-scripts');
    runVisible('ballin_update');
  }

  if (configValue('up.gu') === 'true') {
    progress('Backing up development environment');
    const guStatus = runVisible('gu');
    process.exitCode = guStatus ?? 1;
  }
};

module.exports = {
  runUpCli,
};
