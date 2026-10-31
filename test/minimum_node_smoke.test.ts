const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { testChildEnvironment } = require('./helpers/environment.ts');

const repo = path.resolve(__dirname, '..');
const smoke = path.join(repo, 'test/ci/minimum_node_smoke.ts');

describe('minimum Node.js runtime smoke', () => {
  for (const failChild of [false, true]) {
    it(`${failChild ? 'fails and cleans up after child failure' : 'runs without inheriting caller config or preloads'}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-smoke-caller-'));
      try {
        const config = path.join(root, 'caller.json');
        const preload = path.join(root, 'preload.cjs');
        fs.writeFileSync(config, 'caller config must remain untouched\n');
        fs.writeFileSync(preload, failChild
          ? 'require("node:child_process").spawnSync = () => ({ status: 71, signal: null, stderr: "fixture child failure", stdout: "" });\n'
          : `if (process.argv[1] !== ${JSON.stringify(smoke)} || process.argv[2] === '--probe') throw new Error('Inherited preload escaped supervisor');\n`);
        const result = spawnSync(process.execPath, [smoke], { cwd: root, encoding: 'utf8', timeout: 15000,
          env: testChildEnvironment({ HOME: root, TMPDIR: root, BALLIN_TEST_CONFIG_PATH: config,
            NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, NODE_V8_COVERAGE: undefined }) });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, failChild ? 1 : 0, result.stderr);
        if (failChild) assert.include(result.stderr, 'fixture child failure');
        else assert.equal(result.stdout, `Runtime smoke passed on ${process.version}\n`);
        assert.equal(fs.readFileSync(config, 'utf8'), 'caller config must remain untouched\n');
        assert.deepEqual(fs.readdirSync(root).sort(), ['caller.json', 'preload.cjs']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('keeps exact-minimum CI independent and dependency-free alongside the full LTS lane', () => {
    type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
    const workflow = yaml.load(fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: unknown; 'timeout-minutes': number; steps: Step[] }>;
    };
    const minimum = workflow.jobs['minimum-node'];
    assert.isUndefined(minimum.needs);
    assert.isAtMost(minimum['timeout-minutes'], 5);
    assert.lengthOf(minimum.steps, 3);
    assert.match(minimum.steps[0].uses!, /^actions\/checkout@[a-f0-9]{40}$/u);
    assert.match(minimum.steps[1].uses!, /^actions\/setup-node@[a-f0-9]{40}$/u);
    assert.deepEqual(minimum.steps[1].with, { 'node-version': '24.12.0' });
    assert.equal(minimum.steps[2].run, 'node test/ci/minimum_node_smoke.ts');
    assert.equal(require('../package.json').engines.node, '>=24.12');
    const full = workflow.jobs.test.steps;
    assert.equal(full.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version-file'], '.nvmrc');
    for (const command of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm run typecheck:analytics-worker', 'npm run test:coverage']) {
      assert.isTrue(full.some(step => step.run === command), command);
    }
  });
});
