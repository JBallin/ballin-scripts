const fs = require('fs');
const path = require('path');
const {
  rethrowCommandError,
  runWithCommandAnalytics,
} = require('./analytics.ts');
const {
  configPath,
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
  captureFailed: boolean;
  env: NodeJS.ProcessEnv | null;
  status: number;
};

type ConfigObject = Record<string, unknown>;
type UpdateSetting = 'cleanup' | 'nvm' | 'npm' | 'softwareupdate' | 'selfUpdate' | 'backup';
type UpdateSettings = Record<UpdateSetting, boolean>;

const updateSettingKeys: UpdateSetting[] = [
  'cleanup',
  'nvm',
  'npm',
  'softwareupdate',
  'selfUpdate',
  'backup',
];

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOwn = (value: ConfigObject, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const parseBooleanSetting = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
};

const readConfigObject = (filePath: string, description: string): ConfigObject => {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Unable to read ${description}${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
  if (!isConfigObject(parsed)) {
    throw new Error(`${description} must contain a JSON object.`);
  }
  return parsed;
};

const resolveUpdateSettings = (): UpdateSettings => {
  const defaultConfigPath = path.join(__dirname, '..', 'config', '.defaultConfig.json');
  const defaults = readConfigObject(defaultConfigPath, 'bundled default config');
  if (!isConfigObject(defaults.update)) {
    throw new Error('Bundled default config must contain an update object.');
  }

  const defaultSettings = {} as UpdateSettings;
  updateSettingKeys.forEach((key) => {
    if (!hasOwn(defaults.update as ConfigObject, key)) {
      throw new Error(`Bundled default config is missing update.${key}.`);
    }
    const value = parseBooleanSetting((defaults.update as ConfigObject)[key]);
    if (value === null) {
      throw new Error(`Bundled default update.${key} must be true or false.`);
    }
    defaultSettings[key] = value;
  });

  const userConfig = readConfigObject(configPath, 'Ballin config');
  const hasUpdateSection = hasOwn(userConfig, 'update');
  if (hasUpdateSection && !isConfigObject(userConfig.update)) {
    throw new Error('Ballin config update section must contain a JSON object.');
  }
  const userUpdate = hasUpdateSection ? userConfig.update as ConfigObject : {};
  const settings = { ...defaultSettings };
  const defaultedKeys: string[] = [];

  updateSettingKeys.forEach((key) => {
    if (!hasOwn(userUpdate, key)) {
      defaultedKeys.push(`update.${key}`);
      return;
    }
    const value = parseBooleanSetting(userUpdate[key]);
    if (value === null) {
      throw new Error(`Ballin config update.${key} must be true or false.`);
    }
    settings[key] = value;
  });

  if (defaultedKeys.length > 0) {
    writeStderrLine(`Warning: using bundled defaults for missing settings: ${defaultedKeys.join(', ')}.`);
  }
  return settings;
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
        captureFailed: false,
        env: null,
        status: reportSpawnError('bash', result.error),
      };
    }
    const status = spawnResultStatus(result);
    if (status !== 0 || !fs.existsSync(envPath)) {
      return {
        captureFailed: status === 0,
        env: null,
        status: status === 0 ? 1 : status,
      };
    }

    const nextEnv = parseEnvOutput(fs.readFileSync(envPath, 'utf8'));
    if (!nextEnv) {
      return {
        captureFailed: true,
        env: null,
        status: 1,
      };
    }

    delete nextEnv.BALLIN_UPDATE_ENV_PATH;
    return {
      captureFailed: false,
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

const reportBallinReadiness = (env: NodeJS.ProcessEnv): number => {
  const repoDir = path.join(__dirname, '..');
  const report = collectSetupReadiness({
    repoDir,
    configPath: env.BALLIN_TEST_CONFIG_PATH || undefined,
    env,
    nodeVersion: nodeVersionForEnv(env),
  }) as DoctorReport;

  process.stdout.write(formatDefaultDoctorReport(report));
  return report.status === 'fail' ? 1 : 0;
};

function runUpdateCommand(): void {
  let settings: UpdateSettings;
  try {
    settings = resolveUpdateSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown configuration error.';
    writeStderrLine(`Unable to resolve update configuration: ${message}`);
    process.exitCode = 1;
    return;
  }

  let childEnv = process.env;
  let exitStatus = 0;

  const recordFailure = (status: number): void => {
    if (status !== 0) {
      exitStatus = status;
    }
  };

  const runIntegrationCommand = (
    command: string,
    args: string[] = [],
    options: { env?: NodeJS.ProcessEnv } = {},
  ): number => {
    const status = runVisibleCommand(command, args, options);
    recordFailure(status);
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

    if (settings.cleanup) {
      progress('Cleaning up Homebrew packages');
      runIntegrationCommand('brew', ['cleanup'], { env: childEnv });
    }

    progress('Checking Homebrew installation');
    runIntegrationCommand('brew', ['doctor'], { env: childEnv });
  }

  if (settings.nvm) {
    progress('Updating Node.js LTS');
    const nvmDir = process.env.NVM_DIR ?? '';
    const nvmScript = path.join(nvmDir, 'nvm.sh');
    if (nvmDir && fs.existsSync(nvmScript) && fs.statSync(nvmScript).size > 0) {
      const result = runNvmInstall(childEnv);
      recordFailure(result.status);
      if (result.captureFailed) {
        writeStderrLine('Unable to capture the updated Node.js environment after running nvm.');
      }
      childEnv = result.env ?? childEnv;
    } else {
      writeStderrLine();
      writeStderrLine('Unable to update Node.js LTS: unable to load nvm.');
      writeStderrLine('Set NVM_DIR to your nvm installation or disable this update with: ballin config set update.nvm false');
      recordFailure(1);
    }
  }

  if (settings.npm) {
    if (commandExists('npm', { env: childEnv })) {
      progress('Updating global npm packages');
      runIntegrationCommand('npm', ['update', '-g'], { env: childEnv });
    } else {
      writeStderrLine('Unable to update global npm packages: npm is not available on PATH.');
      recordFailure(1);
    }
  }

  if (commandExists('mas', { env: childEnv })) {
    progress('Updating App Store apps');
    runIntegrationCommand('mas', ['upgrade'], { env: childEnv });
  }

  if (settings.softwareupdate) {
    if (commandExists('softwareupdate', { env: childEnv })) {
      progress('Installing macOS updates');
      runIntegrationCommand('softwareupdate', ['-ia'], { env: childEnv });
    } else {
      writeStderrLine('Unable to install macOS updates: softwareupdate is not available on PATH.');
      recordFailure(1);
    }
  }

  if (settings.selfUpdate) {
    progress('Updating ballin-scripts');
    const updateStatus = runIntegrationCommand(ballinCommandPath(), ['self-update'], { env: childEnv });
    if (updateStatus === 0) {
      progress('Checking Ballin readiness');
      recordFailure(reportBallinReadiness(childEnv));
    }
  }

  if (settings.backup) {
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
