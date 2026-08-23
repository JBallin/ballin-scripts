const fs = require('fs');
const path = require('path');
const {
  commandExists,
  runCommand: defaultRunCommand,
  spawnResultStatus,
} = require('./commandHelpers.ts');
const {
  backupDestinationFromConfig,
} = require('./backup_config.ts');

import type { SpawnSyncOptionsWithStringEncoding } from 'child_process';

type ConfigObject = { [key: string]: unknown };
type RunCommand = (
  command: string,
  args?: string[],
  options?: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'shell'>,
) => {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SetupReadinessStatus = 'pass' | 'warn' | 'fail' | 'info';
type SetupReadinessOverallStatus = Exclude<SetupReadinessStatus, 'info'>;
type SetupReadinessCheck = {
  id: string;
  label: string;
  status: SetupReadinessStatus;
  summary: string;
  details?: string;
  data?: Record<string, unknown>;
};
type SetupReadinessReport = {
  status: SetupReadinessOverallStatus;
  checks: SetupReadinessCheck[];
};
type CollectSetupReadinessOptions = {
  repoDir: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  nodeEngine?: string;
  runCommand?: RunCommand;
};

const isConfigObject = (value: unknown): value is ConfigObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const requiredCommandShims = [
  'ballin',
];

const hasOwn = (obj: ConfigObject, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(obj, key)
);

const readPackageNodeEngine = (repoDir: string): string | null => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as unknown;
    if (!isConfigObject(packageJson) || !isConfigObject(packageJson.engines)) {
      return null;
    }
    const nodeEngine = packageJson.engines.node;
    return typeof nodeEngine === 'string' ? nodeEngine : null;
  } catch {
    return null;
  }
};

const parseVersion = (version: string): number[] | null => {
  const match = version.trim().replace(/^v/u, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  if (!match) {
    return null;
  }
  return [1, 2, 3].map((index) => Number.parseInt(match[index] ?? '0', 10));
};

const parseMinimumEngineVersion = (engine: string): number[] | null => {
  const match = engine.match(/>=\s*(\d+(?:\.\d+){0,2})/u);
  return match ? parseVersion(match[1]) : null;
};

const versionIsAtLeast = (actual: string, minimum: string): boolean | null => {
  const actualVersion = parseVersion(actual);
  const minimumVersion = parseMinimumEngineVersion(minimum);
  if (!actualVersion || !minimumVersion) {
    return null;
  }

  for (let index = 0; index < minimumVersion.length; index += 1) {
    if (actualVersion[index] > minimumVersion[index]) {
      return true;
    }
    if (actualVersion[index] < minimumVersion[index]) {
      return false;
    }
  }
  return true;
};

const nodeRuntimeCheck = (
  repoDir: string,
  nodeVersion: string,
  nodeEngine = readPackageNodeEngine(repoDir),
): SetupReadinessCheck => {
  if (!nodeEngine) {
    return {
      id: 'runtime.node',
      label: 'Node.js runtime',
      status: 'warn',
      summary: 'Unable to determine the supported Node.js version from package.json.',
      data: { nodeVersion },
    };
  }

  const supported = versionIsAtLeast(nodeVersion, nodeEngine);
  if (supported === null) {
    return {
      id: 'runtime.node',
      label: 'Node.js runtime',
      status: 'warn',
      summary: 'Unable to compare the current Node.js version with the configured engine.',
      data: { nodeVersion, nodeEngine },
    };
  }

  return {
    id: 'runtime.node',
    label: 'Node.js runtime',
    status: supported ? 'pass' : 'fail',
    summary: supported
      ? `Node.js ${nodeVersion} satisfies ${nodeEngine}.`
      : `Node.js ${nodeVersion} does not satisfy ${nodeEngine}.`,
    data: { nodeVersion, nodeEngine },
  };
};

const commandShimCheck = (env: NodeJS.ProcessEnv): SetupReadinessCheck => {
  const commands = requiredCommandShims.map((name) => ({
    name,
    found: commandExists(name, { env }),
  }));
  const missing = commands.filter(({ found }) => !found).map(({ name }) => name);

  return {
    id: 'commands.path',
    label: 'Command shims on PATH',
    status: missing.length ? 'fail' : 'pass',
    summary: missing.length
      ? `Missing command shims on PATH: ${missing.join(', ')}.`
      : 'All command shims are discoverable on PATH.',
    data: { commands, missing },
  };
};

const readConfig = (configPath: string): {
  check: SetupReadinessCheck;
  config: ConfigObject | null;
} => {
  let configText = '';
  try {
    configText = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {
      config: null,
      check: {
        id: 'config.read',
        label: 'Config readability',
        status: 'fail',
        summary: `Unable to read ${configPath}.`,
        data: { configPath },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return {
      config: null,
      check: {
        id: 'config.read',
        label: 'Config readability',
        status: 'fail',
        summary: `${configPath} is not valid JSON.`,
        data: { configPath },
      },
    };
  }

  if (!isConfigObject(parsed)) {
    return {
      config: null,
      check: {
        id: 'config.read',
        label: 'Config readability',
        status: 'fail',
        summary: `${configPath} must contain a JSON object.`,
        data: { configPath },
      },
    };
  }

  const requiredSections = ['update', 'backup', 'analytics'];
  const invalidSections = requiredSections.filter((section) => (
    hasOwn(parsed, section) && !isConfigObject(parsed[section])
  ));
  if (invalidSections.length) {
    return {
      config: null,
      check: {
        id: 'config.read',
        label: 'Config readability',
        status: 'fail',
        summary: `Config sections must be JSON objects: ${invalidSections.join(', ')}.`,
        data: { configPath, invalidSections },
      },
    };
  }
  const missingSections = requiredSections.filter((section) => !hasOwn(parsed, section));
  return {
    config: parsed,
    check: {
      id: 'config.read',
      label: 'Config readability',
      status: missingSections.length ? 'warn' : 'pass',
      summary: missingSections.length
        ? `Config is readable but missing sections: ${missingSections.join(', ')}.`
        : 'Config is readable and has the expected top-level sections.',
      data: { configPath, missingSections },
    },
  };
};

const guConfigChecks = (
  config: ConfigObject | null,
  env: NodeJS.ProcessEnv,
  runCommand: RunCommand,
): SetupReadinessCheck[] => {
  if (!config) {
    return [
      {
        id: 'backup.config',
        label: 'Gist backup config',
        status: 'info',
        summary: 'Skipping Gist backup config checks until config is readable.',
      },
      {
        id: 'backup.read',
        label: 'Configured Gist readability',
        status: 'info',
        summary: 'Skipping configured Gist readability check until config is readable.',
      },
    ];
  }

  const destination = backupDestinationFromConfig(config);
  const host = destination.host ?? '';
  const id = destination.id;

  if (destination.idStatus === 'invalid') {
    return [{
      id: 'backup.gist',
      label: 'Gist ID',
      status: 'fail',
      summary: 'backup.id must be null or a non-empty string.',
      data: { configured: false, invalid: true },
    }];
  }

  if (!id) {
    return [{
      id: 'backup.optional',
      label: 'Optional Gist backup',
      status: 'info',
      summary: 'Gist backup is not configured. Maintenance-only Ballin is supported; run ballin backup setup to enable it.',
      data: { configured: false },
    }];
  }

  const checks: SetupReadinessCheck[] = [
    {
      id: 'backup.host',
      label: 'Gist host',
      status: host ? 'pass' : 'fail',
      summary: host
        ? `Gist host is configured as ${host}.`
        : 'Gist host is not configured.',
      data: { host: host || null },
    },
    {
      id: 'backup.gist',
      label: 'Gist ID',
      status: 'pass',
      summary: 'Backup Gist ID is configured.',
      data: { configured: true },
    },
  ];

  const ghAvailable = commandExists('gh', { env });
  checks.push({
    id: 'backup.gh',
    label: 'GitHub CLI',
    status: ghAvailable ? 'pass' : 'fail',
    summary: ghAvailable
      ? 'GitHub CLI is discoverable on PATH.'
      : 'GitHub CLI is not discoverable on PATH.',
    data: { command: 'gh', found: ghAvailable },
  });

  if (!host) {
    checks.push({
      id: 'backup.auth',
      label: 'GitHub CLI authentication',
      status: 'info',
      summary: 'Skipping GitHub CLI authentication check until backup.host is configured.',
    });
    checks.push({
      id: 'backup.read',
      label: 'Configured Gist readability',
      status: 'info',
      summary: 'Skipping configured Gist readability check until backup.host is configured.',
    });
    return checks;
  }

  if (!ghAvailable) {
    checks.push({
      id: 'backup.auth',
      label: 'GitHub CLI authentication',
      status: 'info',
      summary: 'Skipping GitHub CLI authentication check because gh is not on PATH.',
      data: { host },
    });
    checks.push({
      id: 'backup.read',
      label: 'Configured Gist readability',
      status: 'info',
      summary: 'Skipping configured Gist readability check because gh is not on PATH.',
      data: { host },
    });
    return checks;
  }

  const authResult = runCommand('gh', ['auth', 'status', '--active', '--hostname', host], {
    env: {
      ...env,
      GH_HOST: host,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exitStatus = authResult.error ? 1 : spawnResultStatus(authResult);
  const authenticated = !authResult.error && exitStatus === 0;
  checks.push({
    id: 'backup.auth',
    label: 'GitHub CLI authentication',
    status: authenticated ? 'pass' : 'fail',
    summary: authenticated
      ? `GitHub CLI is authenticated for ${host}.`
      : `GitHub CLI is not authenticated for ${host}.`,
    data: { host, exitStatus },
  });

  if (!authenticated) {
    checks.push({
      id: 'backup.read',
      label: 'Configured Gist readability',
      status: 'info',
      summary: 'Skipping configured Gist readability check until GitHub CLI authentication succeeds.',
      data: { host },
    });
    return checks;
  }

  const readResult = runCommand('gh', ['gist', 'view', '--files', '--', id], {
    env: {
      ...env,
      GH_HOST: host,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const readExitStatus = readResult.error ? 1 : spawnResultStatus(readResult);
  const readable = !readResult.error && readExitStatus === 0;
  checks.push({
    id: 'backup.read',
    label: 'Configured Gist readability',
    status: readable ? 'pass' : 'fail',
    summary: readable
      ? 'The configured backup Gist exists and is readable. Write permission was not checked.'
      : 'The configured backup Gist could not be read.',
    data: { host, exitStatus: readExitStatus },
  });

  return checks;
};

const overallStatus = (checks: SetupReadinessCheck[]): SetupReadinessOverallStatus => {
  if (checks.some(({ status }) => status === 'fail')) {
    return 'fail';
  }
  if (checks.some(({ status }) => status === 'warn')) {
    return 'warn';
  }
  return 'pass';
};

const collectSetupReadiness = ({
  repoDir,
  configPath = path.join(repoDir, 'ballin.config.json'),
  env = process.env,
  nodeVersion = process.versions.node,
  nodeEngine,
  runCommand = defaultRunCommand,
}: CollectSetupReadinessOptions): SetupReadinessReport => {
  const checks: SetupReadinessCheck[] = [
    nodeRuntimeCheck(repoDir, nodeVersion, nodeEngine),
    commandShimCheck(env),
  ];
  const { check: configCheck, config } = readConfig(configPath);
  checks.push(configCheck);
  checks.push(...guConfigChecks(config, env, runCommand));

  return {
    status: overallStatus(checks),
    checks,
  };
};

module.exports = {
  collectSetupReadiness,
  requiredCommandShims,
};

export type {
  CollectSetupReadinessOptions,
  SetupReadinessCheck,
  SetupReadinessOverallStatus,
  SetupReadinessReport,
  SetupReadinessStatus,
};
