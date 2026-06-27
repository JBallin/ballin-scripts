const fs = require('fs');
const path = require('path');
const {
  commandExists,
  makeTempFile,
  progress,
  removeTempFile,
  runCommand,
  writeStderrLine,
} = require('./commandHelpers.ts');

const commandPermissionDeniedStatus = 126;
const commandNotFoundStatus = 127;

const reportSpawnError = (command: string, error: Error): number => {
  const errorCode = (error as { code?: string }).code;
  if (errorCode === 'EACCES') {
    writeStderrLine(`${command}: Permission denied`);
    return commandPermissionDeniedStatus;
  }
  if (errorCode === 'ENOENT') {
    writeStderrLine(`${command}: command not found`);
    return commandNotFoundStatus;
  }
  writeStderrLine(error.message);
  return 1;
};

const configValue = (key: string, env = process.env): string => {
  const result = runCommand('ballin_config', ['get', key], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) {
    reportSpawnError('ballin_config', result.error);
    return '';
  }
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
};

const runVisible = (command: string, args: string[] = [], env = process.env): number => {
  const result = runCommand(command, args, { env, stdio: 'inherit' });
  if (result.error) {
    return reportSpawnError(command, result.error);
  }
  return result.status ?? 1;
};

const parseEnvOutput = (output: string): NodeJS.ProcessEnv => JSON.parse(output);

const runNvmInstall = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null => {
  const envPath = makeTempFile('ballin-up-env-');
  try {
    const result = runCommand('bash', [
      '-c',
      '. "$NVM_DIR/nvm.sh"; nvm install --lts; node -e \'process.stdout.write(JSON.stringify(process.env))\' > "$BALLIN_UP_ENV_PATH"',
    ], {
      env: {
        ...env,
        BALLIN_UP_ENV_PATH: envPath,
      },
      stdio: 'inherit',
    });

    if (result.error) {
      reportSpawnError('bash', result.error);
      return null;
    }
    if (!fs.existsSync(envPath)) {
      return null;
    }

    const nextEnv = parseEnvOutput(fs.readFileSync(envPath, 'utf8'));
    delete nextEnv.BALLIN_UP_ENV_PATH;
    return nextEnv;
  } finally {
    removeTempFile(envPath);
  }
};

const runUpCli = (): void => {
  let childEnv = process.env;

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
      childEnv = runNvmInstall(childEnv) ?? childEnv;
    } else {
      writeStderrLine();
      writeStderrLine('⚠️  Skipping Node.js LTS update: unable to load nvm.');
      writeStderrLine('Set NVM_DIR to your nvm installation or disable this update with: ballin_config set up.nvm false');
    }
  }

  if (commandExists('npm', { env: childEnv }) && configValue('up.npm', childEnv) === 'true') {
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
