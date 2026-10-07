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
  installWrangler?: boolean;
  status?: number;
  stderr?: string;
};

const runVerifierCli = (options: VerifierCliOptions = {}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-deploy-'));
  const workerDir = path.join(tempDir, 'analytics-worker');
  const binDir = path.join(workerDir, 'node_modules', '.bin');
  const preloadPath = path.join(tempDir, 'spawn-fixture.cjs');
  const commandLogPath = path.join(tempDir, 'commands.log');
  fs.mkdirSync(binDir, { recursive: true });

  try {
    // Exercise the original CLI and its coverage while routing child execution to owned fixtures.
    fs.writeFileSync(preloadPath, `
const childProcess = require('child_process');
const assert = require('assert');
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  assert.strictEqual(command, ${JSON.stringify(path.join(rootDir, 'analytics-worker', 'node_modules', '.bin', 'wrangler'))});
  assert.strictEqual(options.cwd, ${JSON.stringify(path.join(rootDir, 'analytics-worker'))});
  return spawn(${JSON.stringify(path.join(binDir, 'wrangler'))}, args, { ...options, cwd: ${JSON.stringify(workerDir)} });
};
`);
    if (options.installWrangler !== false) {
      const wranglerPath = path.join(binDir, 'wrangler');
      fs.writeFileSync(wranglerPath, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_WRANGLER_STATUS) {
  process.stderr.write(process.env.FAKE_WRANGLER_STDERR || '');
  process.exitCode = Number(process.env.FAKE_WRANGLER_STATUS);
} else if (args[0] === 'deployments' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ versions: [{ percentage: 100, version_id: 'version-a' }] }));
} else if (args[0] === 'versions' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    id: args[2],
    resources: {
      bindings: [
        { name: 'ANALYTICS_DB', type: 'd1' },
        { name: 'ANALYTICS_RATE_LIMITER', type: 'ratelimit' },
        { name: 'ANALYTICS_SOURCE_RATE_LIMITER', type: 'ratelimit' },
        { name: 'INSTALL_ID_HASH_SECRET', type: 'secret_text', text: 'sensitive-value' },
      ],
    },
  }));
} else {
  process.stderr.write('unexpected fake Wrangler invocation');
  process.exitCode = 97;
}
`);
      fs.chmodSync(wranglerPath, 0o755);
    }

    const result = spawnSync(process.execPath, ['--require', preloadPath, verifierPath], {
      encoding: 'utf8',
      env: testChildEnvironment({
        HOME: tempDir,
        PATH: binDir,
        FAKE_COMMAND_LOG: commandLogPath,
        FAKE_WRANGLER_STATUS: options.status?.toString(),
        FAKE_WRANGLER_STDERR: options.stderr,
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

const yamlListAfter = (source: string, heading: string, indentation: number): string[] => {
  const lines = source.split('\n');
  const headingIndex = lines.indexOf(heading);
  assert.isAtLeast(headingIndex, 0, `missing YAML heading: ${heading.trim()}`);

  const itemPattern = new RegExp(`^ {${indentation}}- (.+)$`, 'u');
  const items: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const match = line.match(itemPattern);
    if (!match) {
      break;
    }
    items.push(match[1].replace(/^(['"])(.*)\1$/u, '$2'));
  }
  return items;
};

const matchesDeployPaths = (files: string[], patterns: string[]): boolean => files.some((file) => (
  patterns.reduce((included, pattern) => {
    const excluded = pattern.startsWith('!');
    const glob = excluded ? pattern.slice(1) : pattern;
    return path.matchesGlob(file, glob) ? !excluded : included;
  }, false)
));

describe('analytics Worker deployment', () => {
  it('keeps automatic deploy triggers and setup scoped to deployment inputs', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');

    assert.deepEqual(yamlListAfter(workflow, '    paths:', 6), [
      'analytics-worker/**',
      '!analytics-worker/README.md',
      '.github/workflows/deploy-analytics-worker.yml',
      '.nvmrc',
    ]);
    assert.match(
      workflow,
      /uses:\s*actions\/setup-node@[a-f0-9]{40}[^\n]*[\s\S]*?node-version-file:\s*\.nvmrc/u,
    );
    assert.notMatch(workflow, /^\s+cache:\s*npm\s*$/mu);
    assert.match(workflow, /^\s+run: npm ci --prefix analytics-worker --include=dev$/mu);
    assert.notMatch(workflow, /^\s+(?:run:\s*)?npm test(?:\s|$)/mu);
  });

  const triggerCases: Array<{ name: string; files: string[]; expected: boolean }> = [
    { name: 'Worker README only', files: ['analytics-worker/README.md'], expected: false },
    { name: 'Worker README and other docs', files: ['analytics-worker/README.md', 'docs/analytics.md'], expected: false },
    { name: 'Worker README and code', files: ['analytics-worker/README.md', 'analytics-worker/src/index.ts'], expected: true },
    { name: 'Worker code', files: ['analytics-worker/src/index.ts'], expected: true },
    { name: 'Worker config', files: ['analytics-worker/wrangler.toml.example'], expected: true },
    { name: 'Worker migration', files: ['analytics-worker/migrations/0004_behavior_events_daily.sql'], expected: true },
    { name: 'future Worker input', files: ['analytics-worker/new-deployment-input.json'], expected: true },
    { name: 'deploy workflow', files: ['.github/workflows/deploy-analytics-worker.yml'], expected: true },
    { name: 'Node runtime', files: ['.nvmrc'], expected: true },
  ];
  triggerCases.forEach(({ name, files, expected }) => {
    it(`${expected ? 'includes' : 'excludes'} ${name} in automatic deploy triggers`, () => {
      const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
      assert.equal(matchesDeployPaths(files, yamlListAfter(workflow, '    paths:', 6)), expected);
    });
  });

  it('preserves main-only push and manual deployment triggers', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    assert.deepEqual(yamlListAfter(workflow, '    branches:', 6), ['main']);
    assert.match(workflow, /^  workflow_dispatch:\s*$/mu);
  });

  it('pins deployment actions and uses an exact integrity-locked Wrangler', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    const config = fs.readFileSync(wranglerConfigPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'analytics-worker', 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'analytics-worker', 'package-lock.json'), 'utf8'));
    const declaredVersion = manifest.devDependencies.wrangler;
    assert.match(declaredVersion, /^4\.\d+\.\d+$/u);
    assert.isAtLeast(compareVersions(declaredVersion.split('.').map(Number), [4, 36, 0]), 0);
    assert.equal(lock.packages[''].devDependencies.wrangler, declaredVersion);
    assert.equal(lock.packages['node_modules/wrangler'].version, declaredVersion);
    for (const [name, metadata] of Object.entries(lock.packages)) {
      if (name === '') continue;
      assert.match((metadata as { integrity: string }).integrity, /^sha512-/u, name);
    }
    const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/gu)].map((match) => match[1]);
    assert.lengthOf(actions, 2);
    for (const action of actions) assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
    assert.notInclude(workflow, 'wrangler-action');
    assert.notInclude(workflow, 'wranglerVersion');
    assert.match(config, /\[\[ratelimits\]\][\s\S]*?name\s*=\s*"ANALYTICS_RATE_LIMITER"/u);
  });

  it('deploys and verifies with the same installed local Wrangler', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    const verifier = fs.readFileSync(verifierPath, 'utf8');
    assert.match(workflow, /working-directory: analytics-worker[\s\S]*?CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}[\s\S]*?CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}[\s\S]*?npm run deploy\n\s+npm run verify:deployment/u);
    assert.include(verifier, "spawnSync(localWranglerPath(path.join(__dirname, '..')), args");
    assert.notInclude(verifier, "spawnSync('npx'");
    assert.deepEqual(requiredBindings, [
      { name: 'ANALYTICS_DB', type: 'd1' },
      { name: 'ANALYTICS_RATE_LIMITER', type: 'ratelimit' },
      { name: 'ANALYTICS_SOURCE_RATE_LIMITER', type: 'ratelimit' },
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
    assert.include(output, 'ANALYTICS_SOURCE_RATE_LIMITER (ratelimit)');
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

  it('requires the source binding on every traffic-serving version', () => {
    const withoutSource = requiredBindings.filter((binding: BindingMetadata) => binding.name !== 'ANALYTICS_SOURCE_RATE_LIMITER');
    assert.throws(() => verifyProductionDeployment(runnerFor([
      { percentage: 50, version_id: 'version-a' }, { percentage: 50, version_id: 'version-b' },
    ], { 'version-a': requiredBindings, 'version-b': withoutSource })), 'missing required binding ANALYTICS_SOURCE_RATE_LIMITER');
    const source = { name: 'ANALYTICS_SOURCE_RATE_LIMITER', type: 'ratelimit' };
    assert.throws(() => verifyBindings('duplicate-source', [...requiredBindings, source]), 'duplicate binding metadata for ANALYTICS_SOURCE_RATE_LIMITER');
    assert.throws(() => verifyBindings('wrong-source', [...withoutSource, { ...source, type: 'kv_namespace' }]), 'expected ratelimit');
  });

  it('configures a distinct lower source window while preserving global and installation policy', () => {
    const config = fs.readFileSync(wranglerConfigPath, 'utf8');
    const entries = config.split('[[ratelimits]]').slice(1);
    assert.lengthOf(entries, 2);
    const settings = entries.map((entry: string) => ({
      name: entry.match(/name\s*=\s*"([^"]+)"/u)![1],
      namespace: entry.match(/namespace_id\s*=\s*"([^"]+)"/u)![1],
      limit: Number(entry.match(/limit\s*=\s*([0-9_]+)/u)![1].replaceAll('_', '')),
      period: Number(entry.match(/period\s*=\s*([0-9]+)/u)![1]),
    }));
    assert.deepEqual(settings, [
      { name: 'ANALYTICS_RATE_LIMITER', namespace: '1001', limit: 1500, period: 60 },
      { name: 'ANALYTICS_SOURCE_RATE_LIMITER', namespace: '1002', limit: 1000, period: 60 },
    ]);
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
      ['deployments', 'status', '--json'],
      ['versions', 'view', 'version-a', '--json'],
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
      ['deployments', 'status', '--json'],
    ]);
  });

  it('requires local Wrangler for the real verifier CLI', () => {
    const { calls, result } = runVerifierCli({ installWrangler: false });

    assert.isUndefined(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'analytics deployment verification: Missing local Wrangler. Run npm ci --prefix analytics-worker --include=dev from the repository root.\n',
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
