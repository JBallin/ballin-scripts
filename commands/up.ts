const fs = require('fs');
const path = require('path');
const {
  commandExists,
  progress,
  readCommandOutput,
  runCommand,
  writeStderrLine,
} = require('./commandHelpers.ts');

const commandNotFoundStatus = 127;

const configValue = (key: string, env = process.env): string => {
  const value = readCommandOutput('ballin_config', ['get', key], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return value?.trim() ?? '';
};

const runVisible = (command: string, args: string[] = [], env = process.env): number => {
  const result = runCommand(command, args, { env, stdio: 'inherit' });
  if (result.error) {
    writeStderrLine(`${command}: command not found`);
    return commandNotFoundStatus;
  }
  return result.status ?? 1;
};

const runUpCli = (): void => {
  let childEnv = process.env;
  let npmHandledByNvm = false;

  if (commandExists('brew')) {
    progress('Updating Homebrew packages');
    childEnv = {
      ...process.env,
      HOMEBREW_NO_ENV_HINTS: '1',
      HOMEBREW_NO_ASK: '1',
    };
    runVisible('brew', ['upgrade'], childEnv);

    if (configValue('up.cleanup', childEnv) === 'true') {
      progress('Cleaning up Homebrew packages');
      runVisible('brew', ['cleanup'], childEnv);
    }

    progress('Checking Homebrew installation');
    runVisible('brew', ['doctor'], childEnv);
  }

  if (configValue('up.nvm', childEnv) === 'true') {
    progress('Updating Node.js LTS');
    const nvmDir = process.env.NVM_DIR ?? '';
    const nvmScript = path.join(nvmDir, 'nvm.sh');
    if (nvmDir && fs.existsSync(nvmScript) && fs.statSync(nvmScript).size > 0) {
      npmHandledByNvm = configValue('up.npm', childEnv) === 'true';
      runCommand('bash', [
        '-c',
        [
          '. "$NVM_DIR/nvm.sh"',
          'nvm install --lts',
          npmHandledByNvm
            ? 'if command -v npm >/dev/null 2>&1; then printf \'\\n==> Updating global npm packages\\n\'; npm update -g; fi'
            : '',
        ].filter(Boolean).join('; '),
      ], {
        env: childEnv,
        stdio: 'inherit',
      });
    } else {
      writeStderrLine();
      writeStderrLine('⚠️  Skipping Node.js LTS update: unable to load nvm.');
      writeStderrLine('Set NVM_DIR to your nvm installation or disable this update with: ballin_config set up.nvm false');
    }
  }

  if (!npmHandledByNvm && commandExists('npm', { env: childEnv }) && configValue('up.npm', childEnv) === 'true') {
    progress('Updating global npm packages');
    runVisible('npm', ['update', '-g'], childEnv);
  }

  if (commandExists('mas', { env: childEnv })) {
    progress('Updating App Store apps');
    runVisible('mas', ['upgrade'], childEnv);
  }

  if (commandExists('softwareupdate', { env: childEnv }) && configValue('up.softwareupdate', childEnv) === 'true') {
    progress('Installing macOS updates');
    runVisible('softwareupdate', ['-ia'], childEnv);
  }

  if (configValue('up.ballin', childEnv) === 'true') {
    progress('Updating ballin-scripts');
    runVisible('ballin_update', [], childEnv);
  }

  if (configValue('up.gu', childEnv) === 'true') {
    progress('Backing up development environment');
    process.exitCode = runVisible('gu', [], childEnv);
  }
};

module.exports = {
  runUpCli,
};
