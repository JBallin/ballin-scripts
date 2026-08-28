const { spawnSync } = require('child_process');

type WranglerRunner = (args: string[]) => string;
type OutputWriter = (value: string) => unknown;

type BindingContract = {
  name: string;
  type: string;
};

type BindingMetadata = {
  name: string;
  type: string;
};

const requiredBindings: BindingContract[] = [
  { name: 'ANALYTICS_DB', type: 'd1' },
  { name: 'ANALYTICS_RATE_LIMITER', type: 'ratelimit' },
  { name: 'INSTALL_ID_HASH_SECRET', type: 'secret_text' },
];

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseJsonObject = (value: string, description: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${description} returned an unexpected JSON shape`);
  }
  return parsed;
};

const trafficVersionIds = (deploymentJson: string): string[] => {
  const deployment = parseJsonObject(deploymentJson, 'Wrangler deployment status');
  if (!Array.isArray(deployment.versions)) {
    throw new Error('Wrangler deployment status is missing versions metadata');
  }

  const versionIds = new Set<string>();
  for (const entry of deployment.versions) {
    if (
      !isObject(entry)
      || typeof entry.version_id !== 'string'
      || entry.version_id.length === 0
      || typeof entry.percentage !== 'number'
      || !Number.isFinite(entry.percentage)
      || entry.percentage < 0
      || entry.percentage > 100
    ) {
      throw new Error('Wrangler deployment status contains invalid version traffic metadata');
    }
    if (entry.percentage > 0) {
      versionIds.add(entry.version_id);
    }
  }

  if (versionIds.size === 0) {
    throw new Error('Wrangler deployment status has no traffic-serving versions');
  }
  return [...versionIds];
};

const versionBindings = (versionJson: string, expectedVersionId: string): BindingMetadata[] => {
  const version = parseJsonObject(versionJson, `Wrangler version ${expectedVersionId}`);
  if (version.id !== expectedVersionId) {
    throw new Error(`Wrangler returned metadata for an unexpected version instead of ${expectedVersionId}`);
  }
  if (!isObject(version.resources) || !Array.isArray(version.resources.bindings)) {
    throw new Error(`Wrangler version ${expectedVersionId} is missing bindings metadata`);
  }

  return version.resources.bindings.map((binding) => {
    if (!isObject(binding) || typeof binding.name !== 'string' || typeof binding.type !== 'string') {
      throw new Error(`Wrangler version ${expectedVersionId} contains invalid binding metadata`);
    }
    return { name: binding.name, type: binding.type };
  });
};

const verifyBindings = (versionId: string, bindings: BindingMetadata[]): void => {
  for (const required of requiredBindings) {
    const matches = bindings.filter((binding) => binding.name === required.name);
    if (matches.length === 0) {
      throw new Error(`Production version ${versionId} is missing required binding ${required.name}`);
    }
    if (matches.length > 1) {
      throw new Error(`Production version ${versionId} has duplicate binding metadata for ${required.name}`);
    }
    if (matches[0].type !== required.type) {
      throw new Error(
        `Production version ${versionId} binding ${required.name} has type ${matches[0].type}; expected ${required.type}`,
      );
    }
  }
};

const runWrangler: WranglerRunner = (args) => {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Wrangler ${args.slice(0, 2).join(' ')} failed`);
  }
  return result.stdout;
};

const verifyProductionDeployment = (runner: WranglerRunner = runWrangler): string => {
  const deploymentJson = runner(['deployments', 'status', '--json']);
  const versionIds = trafficVersionIds(deploymentJson);

  for (const versionId of versionIds) {
    const versionJson = runner(['versions', 'view', versionId, '--json']);
    verifyBindings(versionId, versionBindings(versionJson, versionId));
  }

  const bindingSummary = requiredBindings
    .map((binding) => `${binding.name} (${binding.type})`)
    .join(', ');
  return [
    `Verified required bindings for ${versionIds.length} traffic-serving production version(s):`,
    ...versionIds.map((versionId) => `- ${versionId}: ${bindingSummary}`),
    '',
  ].join('\n');
};

const runCli = (
  runner: WranglerRunner = runWrangler,
  writeStdout: OutputWriter = (value) => process.stdout.write(value),
  writeStderr: OutputWriter = (value) => process.stderr.write(value),
): number => {
  try {
    writeStdout(verifyProductionDeployment(runner));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verification failure';
    writeStderr(`analytics deployment verification: ${message}\n`);
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  parseJsonObject,
  requiredBindings,
  runCli,
  runWrangler,
  trafficVersionIds,
  verifyBindings,
  verifyProductionDeployment,
  versionBindings,
};
