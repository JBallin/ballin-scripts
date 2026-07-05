const fs = require('fs');
const path = require('path');
const {
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const {
  getConfig,
} = require('../config/index.ts');
const {
  formatDefaultDoctorReport,
} = require('./doctor_report.ts');
const {
  collectSetupReadiness,
} = require('./setup_readiness.ts');
const {
  commandExists,
  makeTempFile,
  progress,
  reportSpawnError,
  removeTempFile,
  runCommand,
  runVisibleCommand,
  spawnResultStatus,
  writeStderrLine,
} = require('./commandHelpers.ts');
import type { DoctorReport } from './doctor_report.ts';

type NvmInstallResult = {
  env: NodeJS.ProcessEnv | null;
  status: number;
};

const configValue = (key: string): string => {
  try {
    const value = getConfig(key);
    if (typeof value === 'string' && value.startsWith('INVALID:')) {
      return '';
    }
    return value === null ? '' : String(value).trim();
  } catch (error) {
    if (error instanceof Error) {
      writeStderrLine(`Unable to read config: ${error.message}`);
    }
    return '';
  }
};

const parseEnvOutput = (output: string): NodeJS.ProcessEnv | null => {
  if (!output.trim()) {
    return null;
  }

  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
};

const runNvmInstall = (env: NodeJS.ProcessEnv): NvmInstallResult => {
  const envPath = makeTempFile('ballin-update-env-');
  try {
    const result = runCommand('bash', [
      '-c',
      '. "$NVM_DIR/nvm.sh"; nvm install --lts; nvm_status="$?"; node -e \'process.stdout.write(JSON.stringify(process.env))\' > "$BALLIN_UPDATE_ENV_PATH"; exit "$nvm_status"',
    ], {
      env: {
        ...env,
        BALLIN_UPDATE_ENV_PATH: envPath,
      },
      stdio: 'inherit',
    });

    if (result.error) {
      return {
        env: null,
        status: reportSpawnError('bash', result.error),
      };
    }
    const status = spawnResultStatus(result);
    if (status !== 0 || !fs.existsSync(envPath)) {
      return {
        env: null,
        status,
      };
    }

    const nextEnv = parseEnvOutput(fs.readFileSync(envPath, 'utf8'));
    if (!nextEnv) {
      return {
        env: null,
        status,
      };
    }

    delete nextEnv.BALLIN_UPDATE_ENV_PATH;
    return {
      env: nextEnv,
      status,
    };
  } finally {
    removeTempFile(envPath);
  }
};

const nodeVersionForEnv = (env: NodeJS.ProcessEnv): string | undefined => {
  const result = runCommand('node', ['-p', 'process.versions.node'], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
};

const ballinCommandPath = (): string => (
  process.env.BALLIN_TEST_BALLIN_PATH || path.join(__dirname, '..', 'bin', 'ballin')
);

const reportBallinReadiness = (env: NodeJS.ProcessEnv): void => {
  const repoDir = path.join(__dirname, '..');
  const report = collectSetupReadiness({
    repoDir,
    configPath: env.BALLIN_TEST_CONFIG_PATH || undefined,
    env,
    nodeVersion: nodeVersionForEnv(env),
  }) as DoctorReport;

  process.stdout.write(formatDefaultDoctorReport(report));
};

function runUpdateCommand(): void {
  let childEnv = process.env;
  let exitStatus = 0;

  const runIntegrationCommand = (
    command: string,
    args: string[] = [],
    options: { env?: NodeJS.ProcessEnv } = {},
  ): number => {
    const status = runVisibleCommand(command, args, options);
    if (status !== 0) {
      exitStatus = status;
    }
    return status;
  };

  if (commandExists('brew')) {
    progress('Updating Homebrew packages');
    childEnv = {
      ...process.env,
      HOMEBREW_NO_ENV_HINTS: '1',
      HOMEBREW_NO_ASK: '1',
    };
    runIntegrationCommand('brew', ['upgrade'], { env: childEnv });

    if (configValue('update.cleanup') === 'true') {
      progress('Cleaning up Homebrew packages');
      runIntegrationCommand('brew', ['cleanup'], { env: childEnv });
    }

    progress('Checking Homebrew installation');
    runIntegrationCommand('brew', ['doctor'], { env: childEnv });
  }

  if (configValue('update.nvm') === 'true') {
    progress('Updating Node.js LTS');
    const nvmDir = process.env.NVM_DIR ?? '';
    const nvmScript = path.join(nvmDir, 'nvm.sh');
    if (nvmDir && fs.existsSync(nvmScript) && fs.statSync(nvmScript).size > 0) {
      const result = runNvmInstall(childEnv);
      if (result.status !== 0) {
        exitStatus = result.status;
      }
      childEnv = result.env ?? childEnv;
    } else {
      writeStderrLine();
      writeStderrLine('⚠️  Skipping Node.js LTS update: unable to load nvm.');
      writeStderrLine('Set NVM_DIR to your nvm installation or disable this update with: ballin config set update.nvm false');
    }
  }

  if (commandExists('npm', { env: childEnv }) && configValue('update.npm') === 'true') {
    progress('Updating global npm packages');
    runIntegrationCommand('npm', ['update', '-g'], { env: childEnv });
  }

  if (commandExists('mas', { env: childEnv })) {
    progress('Updating App Store apps');
    runIntegrationCommand('mas', ['upgrade'], { env: childEnv });
  }

  if (commandExists('softwareupdate', { env: childEnv }) && configValue('update.softwareupdate') === 'true') {
    progress('Installing macOS updates');
    runIntegrationCommand('softwareupdate', ['-ia'], { env: childEnv });
  }

  if (configValue('update.selfUpdate') === 'true') {
    progress('Updating ballin-scripts');
    const updateStatus = runIntegrationCommand(ballinCommandPath(), ['self-update'], { env: childEnv });
    if (updateStatus === 0) {
      progress('Checking Ballin readiness');
      reportBallinReadiness(childEnv);
    }
  }

  if (configValue('update.backup') === 'true') {
    progress('Backing up development environment');
    runIntegrationCommand(ballinCommandPath(), ['backup'], { env: childEnv });
  }

  if (exitStatus !== 0) {
    process.exitCode = exitStatus;
  }
}

const runUpdateCli = (): void => {
  void runWithCommandAnalytics('ballin update', runUpdateCommand).catch(rethrowCommandError);
};

module.exports = {
  runUpdateCommand,
  runUpdateCli,
};
