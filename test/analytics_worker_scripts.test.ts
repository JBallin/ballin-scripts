const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const workerSource = path.join(__dirname, '..', 'analytics-worker');
const npmCli = process.env.npm_execpath
  ?? path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

type ScriptCall = { args: string[]; cwd: string; token: string; account: string };

const withScriptFixture = (action: (fixture: {
  root: string;
  worker: string;
  local: string;
  fallback: string;
  calls: () => ScriptCall[];
  run: (script: string, args?: string[]) => ReturnType<typeof spawnSync>;
}) => void): void => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-worker-scripts-')));
  const worker = path.join(root, 'analytics-worker');
  const local = path.join(worker, 'node_modules', '.bin', 'wrangler');
  const bin = path.join(root, 'node_modules', '.bin');
  const callLog = path.join(root, 'calls.jsonl');
  const fallback = path.join(root, 'fallback');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const filename of ['package.json', 'reset.ts', 'verify-deployment.ts', 'wrangler.ts']) {
    fs.copyFileSync(path.join(workerSource, filename), path.join(worker, filename));
  }
  fs.writeFileSync(path.join(worker, 'wrangler.toml'), '');
  fs.writeFileSync(path.join(root, 'npmrc'), '');
  fs.writeFileSync(path.join(root, 'global-npmrc'), '');
  fs.writeFileSync(local, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify({
  args, cwd: process.cwd(), token: process.env.CLOUDFLARE_API_TOKEN,
  account: process.env.CLOUDFLARE_ACCOUNT_ID,
}) + '\\n');
if (args[0] === 'deployments') {
  process.stdout.write(JSON.stringify({versions:[{percentage:100,version_id:'fixture-version'}]}));
} else if (args[0] === 'versions') {
  process.stdout.write(JSON.stringify({id:args[2],resources:{bindings:[
    {name:'ANALYTICS_DB',type:'d1'},
    {name:'ANALYTICS_RATE_LIMITER',type:'ratelimit'},
    {name:'INSTALL_ID_HASH_SECRET',type:'secret_text'},
  ]}}));
} else {
  process.stdout.write('[{"results":[{"table_name":"install_days","rows":3}],"success":true}]');
}
`);
  fs.chmodSync(local, 0o755);
  for (const name of ['wrangler', 'npx']) {
    const filename = path.join(bin, name);
    fs.writeFileSync(filename, `#!${process.execPath}
require('fs').writeFileSync(process.env.FAKE_FALLBACK, 'unexpected');
process.exitCode = 99;
`);
    fs.chmodSync(filename, 0o755);
  }
  try {
    action({
      root, worker, local, fallback,
      calls: () => fs.existsSync(callLog)
        ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line))
        : [],
      run: (script, args = []) => spawnSync(process.execPath, [
        npmCli, '--prefix', worker, 'run', script, '--', ...args,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: testChildEnvironment({
          HOME: root,
          PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
          NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
          NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'),
          NPM_CONFIG_GLOBALCONFIG: path.join(root, 'global-npmrc'),
          NPM_CONFIG_SCRIPT_SHELL: '/bin/sh',
          CLOUDFLARE_API_TOKEN: 'fixture-token',
          CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
          FAKE_CALL_LOG: callLog,
          FAKE_FALLBACK: fallback,
        }),
      }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe('analytics Worker package scripts', () => {
  for (const [script, args, expected] of [
    ['wrangler', ['login'], ['login']],
    ['deploy', ['--dry-run'], ['deploy', '--dry-run']],
    ['migrate:remote', [], ['d1', 'migrations', 'apply', 'ballin-scripts-analytics', '--remote']],
  ] as Array<[string, string[], string[]]>) {
    it(`routes ${script} to the local tool with Worker cwd and authentication`, () => {
      withScriptFixture((fixture) => {
        const result = fixture.run(script, args);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fixture.calls(), [{
          args: expected, cwd: fixture.worker,
          token: 'fixture-token', account: 'fixture-account',
        }]);
        assert.isFalse(fs.existsSync(fixture.fallback));
      });
    });
  }

  it('runs deployment verification through the locked tool', () => {
    withScriptFixture((fixture) => {
      const result = fixture.run('verify:deployment');
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Verified required bindings');
      assert.deepEqual(fixture.calls().map((call) => call.args), [
        ['deployments', 'status', '--json'],
        ['versions', 'view', 'fixture-version', '--json'],
      ]);
      assert.isTrue(fixture.calls().every((call) => call.cwd === fixture.worker));
    });
  });

  it('preserves reset confirmation and dry-run argument forwarding', () => {
    withScriptFixture((fixture) => {
      const refused = fixture.run('reset');
      assert.equal(refused.status, 1);
      assert.include(refused.stderr, 'Refusing to reset analytics');
      assert.deepEqual(fixture.calls(), []);
      const preview = fixture.run('reset', ['--dry-run']);
      assert.equal(preview.status, 0, preview.stderr);
      assert.lengthOf(fixture.calls(), 1);
      assert.notInclude(fixture.calls()[0].args.join(' '), 'DELETE');
      assert.equal(fixture.calls()[0].cwd, fixture.root);
      assert.deepEqual(fixture.calls()[0].args.slice(0, 2), [
        '--config', path.join(fixture.worker, 'wrangler.toml'),
      ]);
    });
  });

  it('forwards explicit reset confirmation to the existing reset utility', () => {
    withScriptFixture((fixture) => {
      const result = fixture.run('reset', ['--confirm', 'RESET_ANALYTICS_AGGREGATES']);
      assert.equal(result.status, 0, result.stderr);
      assert.lengthOf(fixture.calls(), 3);
      assert.include(fixture.calls()[1].args.join(' '), 'DELETE FROM install_days;');
    });
  });

  for (const script of ['wrangler', 'deploy', 'migrate:remote', 'verify:deployment', 'reset']) {
    it(`fails ${script} without using an ambient tool when local Wrangler is missing`, () => {
      withScriptFixture((fixture) => {
        fs.rmSync(fixture.local);
        const args = script === 'wrangler' ? ['login'] : script === 'reset' ? ['--dry-run'] : [];
        const result = fixture.run(script, args);
        assert.isNotNull(result.status);
        assert.notEqual(result.status, 0);
        assert.include(result.stderr, script === 'verify:deployment' || script === 'reset'
          ? 'Missing local Wrangler' : 'wrangler');
        assert.deepEqual(fixture.calls(), []);
        assert.isFalse(fs.existsSync(fixture.fallback));
      });
    });
  }
});
