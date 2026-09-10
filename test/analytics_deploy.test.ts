const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testChildEnvironment } = require('./helpers/environment.ts');
const {
  requiredBindings,
  runCli,
  trafficVersionIds,
  verifyBindings,
  verifyProductionDeployment,
  versionBindings,
} = require('../analytics-worker/verify-deployment.ts');

const rootDir = path.join(__dirname, '..');
const deployWorkflowPath = path.join(rootDir, '.github', 'workflows', 'deploy-analytics-worker.yml');
const wranglerConfigPath = path.join(rootDir, 'analytics-worker', 'wrangler.toml.example');
const verifierPath = path.join(rootDir, 'analytics-worker', 'verify-deployment.ts');

type TrafficVersion = {
  percentage: number;
  version_id: string;
};

type BindingMetadata = {
  name: string;
  text?: string;
  type: string;
};

type VersionBindings = Record<string, BindingMetadata[]>;

const deploymentJson = (versions: TrafficVersion[]): string => JSON.stringify({ versions });

const versionJson = (id: string, bindings: BindingMetadata[]): string => JSON.stringify({
  id,
  resources: { bindings },
});

type VerifierCliOptions = {
  installNpx?: boolean;
  status?: number;
  stderr?: string;
};

const runVerifierCli = (options: VerifierCliOptions = {}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-deploy-'));
  const binDir = path.join(tempDir, 'bin');
  const commandLogPath = path.join(tempDir, 'commands.log');
  fs.mkdirSync(binDir);

  try {
    if (options.installNpx !== false) {
      const npxPath = path.join(binDir, 'npx');
      fs.writeFileSync(npxPath, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_NPX_STATUS) {
  process.stderr.write(process.env.FAKE_NPX_STDERR || '');
  process.exitCode = Number(process.env.FAKE_NPX_STATUS);
} else if (args[2] === 'deployments' && args[3] === 'status') {
  process.stdout.write(JSON.stringify({ versions: [{ percentage: 100, version_id: 'version-a' }] }));
} else if (args[2] === 'versions' && args[3] === 'view') {
  process.stdout.write(JSON.stringify({
    id: args[4],
    resources: {
      bindings: [
        { name: 'ANALYTICS_DB', type: 'd1' },
        { name: 'ANALYTICS_RATE_LIMITER', type: 'ratelimit' },
        { name: 'INSTALL_ID_HASH_SECRET', type: 'secret_text', text: 'sensitive-value' },
      ],
    },
  }));
} else {
  process.stderr.write('unexpected fake npx invocation');
  process.exitCode = 97;
}
`);
      fs.chmodSync(npxPath, 0o755);
    }

    const result = spawnSync(process.execPath, [verifierPath], {
      encoding: 'utf8',
      env: testChildEnvironment({
        HOME: tempDir,
        PATH: binDir,
        FAKE_COMMAND_LOG: commandLogPath,
        FAKE_NPX_STATUS: options.status?.toString(),
        FAKE_NPX_STDERR: options.stderr,
      }),
    });
    const calls = fs.existsSync(commandLogPath)
      ? fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line))
      : [];
    return { calls, result };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const runnerFor = (
  versions: TrafficVersion[],
  bindingsByVersion: VersionBindings,
  calls: string[][] = [],
) => (args: string[]): string => {
  calls.push(args);
  if (args[0] === 'deployments' && args[1] === 'status') {
    return deploymentJson(versions);
  }
  const versionId = args[2];
  const bindings = bindingsByVersion[versionId];
  if (!bindings) {
    throw new Error(`Unexpected version request: ${versionId}`);
  }
  return versionJson(versionId, bindings);
};

const compareVersions = (left: number[], right: number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

describe('analytics Worker deployment', () => {
  it('uses a compatible Wrangler version for the production rate-limit binding', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    const config = fs.readFileSync(wranglerConfigPath, 'utf8');
    const versionMatch = workflow.match(/wranglerVersion:\s*["']\^(\d+)\.(\d+)\.(\d+)["']/u);

    assert.match(workflow, /uses:\s*cloudflare\/wrangler-action@v4\b/u);
    assert.isNotNull(versionMatch, 'deployment must declare a caret Wrangler version range');

    const lowerBound = versionMatch?.slice(1).map(Number) ?? [];
    assert.equal(lowerBound[0], 4, 'deployment must stay on the compatible Wrangler 4 line');
    assert.isAtLeast(
      compareVersions(lowerBound, [4, 36, 0]),
      0,
      'rate-limit bindings require Wrangler 4.36.0 or newer',
    );
    assert.match(
      config,
      /\[\[ratelimits\]\][\s\S]*?name\s*=\s*"ANALYTICS_RATE_LIMITER"/u,
    );
  });

  it('runs structured production verification in the deploy action context', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    const verifier = fs.readFileSync(verifierPath, 'utf8');

    assert.match(workflow, /workingDirectory:\s*analytics-worker[\s\S]*?postCommands:\s*node verify-deployment\.ts/u);
    assert.include(verifier, "spawnSync('npx', ['--no-install', 'wrangler', ...args]");
    assert.include(verifier, "runner(['deployments', 'status', '--json'])");
    assert.include(verifier, "runner(['versions', 'view', versionId, '--json'])");
    assert.deepEqual(requiredBindings, [
      { name: 'ANALYTICS_DB', type: 'd1' },
      { name: 'ANALYTICS_RATE_LIMITER', type: 'ratelimit' },
      { name: 'INSTALL_ID_HASH_SECRET', type: 'secret_text' },
    ]);
  });

  it('verifies every traffic-serving version and ignores zero-percent versions', () => {
    const calls: string[][] = [];
    const bindings = [
      ...requiredBindings,
      { name: 'UNRELATED_SECRET', type: 'secret_text', text: 'must-not-appear' },
    ];
    const output = verifyProductionDeployment(runnerFor([
      { percentage: 50, version_id: 'version-a' },
      { percentage: 50, version_id: 'version-b' },
      { percentage: 0, version_id: 'old-version' },
    ], {
      'version-a': bindings,
      'version-b': bindings,
    }, calls));

    assert.deepEqual(calls, [
      ['deployments', 'status', '--json'],
      ['versions', 'view', 'version-a', '--json'],
      ['versions', 'view', 'version-b', '--json'],
    ]);
    assert.include(output, '2 traffic-serving production version(s)');
    assert.include(output, 'ANALYTICS_RATE_LIMITER (ratelimit)');
    assert.notInclude(output, 'must-not-appear');
    assert.notInclude(output, 'UNRELATED_SECRET');
  });

  it('fails when required binding metadata is missing, duplicated, or mistyped', () => {
    assert.throws(
      () => verifyBindings('missing-version', requiredBindings.slice(1)),
      'Production version missing-version is missing required binding ANALYTICS_DB',
    );
    assert.throws(
      () => verifyBindings('duplicate-version', [requiredBindings[0], ...requiredBindings]),
      'Production version duplicate-version has duplicate binding metadata for ANALYTICS_DB',
    );
    assert.throws(
      () => verifyBindings('wrong-type-version', [
        { name: 'ANALYTICS_DB', type: 'kv_namespace' },
        ...requiredBindings.slice(1),
      ]),
      'Production version wrong-type-version binding ANALYTICS_DB has type kv_namespace; expected d1',
    );
  });

  it('fails closed on malformed deployment or version metadata', () => {
    assert.throws(() => trafficVersionIds('not json'), 'Wrangler deployment status returned invalid JSON');
    assert.throws(
      () => trafficVersionIds('null'),
      'Wrangler deployment status returned an unexpected JSON shape',
    );
    assert.throws(
      () => trafficVersionIds('{}'),
      'Wrangler deployment status is missing versions metadata',
    );
    assert.throws(
      () => trafficVersionIds(deploymentJson([])),
      'Wrangler deployment status has no traffic-serving versions',
    );
    assert.throws(
      () => trafficVersionIds(deploymentJson([{ percentage: -1, version_id: 'invalid' }])),
      'Wrangler deployment status contains invalid version traffic metadata',
    );
    assert.throws(
      () => versionBindings(JSON.stringify({ id: 'version-a', resources: {} }), 'version-a'),
      'Wrangler version version-a is missing bindings metadata',
    );
    assert.throws(
      () => versionBindings(versionJson('version-b', requiredBindings), 'version-a'),
      'Wrangler returned metadata for an unexpected version instead of version-a',
    );
    assert.throws(
      () => versionBindings(JSON.stringify({
        id: 'version-a',
        resources: { bindings: [null] },
      }), 'version-a'),
      'Wrangler version version-a contains invalid binding metadata',
    );
  });

  it('runs the real verifier CLI through isolated Wrangler commands', () => {
    const { calls, result } = runVerifierCli();

    assert.isUndefined(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.include(result.stdout, 'Verified required bindings for 1 traffic-serving production version(s)');
    assert.include(result.stdout, 'INSTALL_ID_HASH_SECRET (secret_text)');
    assert.notInclude(result.stdout, 'sensitive-value');
    assert.deepEqual(calls, [
      ['--no-install', 'wrangler', 'deployments', 'status', '--json'],
      ['--no-install', 'wrangler', 'versions', 'view', 'version-a', '--json'],
    ]);
  });

  it('fails the real verifier CLI without exposing Wrangler stderr', () => {
    const { calls, result } = runVerifierCli({
      status: 23,
      stderr: 'sensitive Wrangler failure details',
    });

    assert.isUndefined(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'analytics deployment verification: Wrangler deployments status failed\n',
    );
    assert.notInclude(result.stderr, 'sensitive Wrangler failure details');
    assert.deepEqual(calls, [
      ['--no-install', 'wrangler', 'deployments', 'status', '--json'],
    ]);
  });

  it('fails the real verifier CLI when npx cannot be started', () => {
    const { calls, result } = runVerifierCli({ installNpx: false });

    assert.isUndefined(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'analytics deployment verification: Wrangler deployments status failed\n',
    );
    assert.deepEqual(calls, []);
  });

  it('returns a nonzero CLI status without printing secret values when verification fails', () => {
    let stdout = '';
    let stderr = '';
    const status = runCli(
      runnerFor([{ percentage: 100, version_id: 'bad-version' }], {
        'bad-version': [
          { name: 'INSTALL_ID_HASH_SECRET', type: 'secret_text', text: 'sensitive-value' },
        ],
      }),
      (value: string) => { stdout += value; },
      (value: string) => { stderr += value; },
    );

    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.include(stderr, 'missing required binding ANALYTICS_DB');
    assert.notInclude(stderr, 'sensitive-value');
  });

  it('returns a nonzero CLI status when structured Wrangler inspection fails', () => {
    let stderr = '';
    const status = runCli(
      () => { throw new Error('Wrangler deployments status failed'); },
      () => { throw new Error('stdout should remain empty'); },
      (value: string) => { stderr += value; },
    );

    assert.equal(status, 1);
    assert.equal(
      stderr,
      'analytics deployment verification: Wrangler deployments status failed\n',
    );
  });
});
