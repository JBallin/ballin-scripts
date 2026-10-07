const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { localWranglerPath, missingWranglerMessage } = require('../analytics-worker/wrangler.ts');

describe('local analytics maintenance tool', () => {
  for (const utility of ['report', 'reset']) {
    it(`uses only installed local Wrangler for ${utility}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-local-wrangler-'));
      try {
        const worker = path.join(root, 'analytics-worker');
        const bin = path.join(root, 'bin');
        const calls = path.join(root, 'calls.json');
        const fallback = path.join(root, 'fallback');
        const local = localWranglerPath(root);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(worker, 'wrangler.toml'), '');
        fs.writeFileSync(local, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)));
process.stdout.write('[{"results":[{"total":1}],"success":true}]');
`);
        fs.chmodSync(local, 0o755);
        for (const command of ['wrangler', 'npx']) {
          const filename = path.join(bin, command);
          fs.writeFileSync(filename, `#!${process.execPath}
require('fs').writeFileSync(process.env.FALLBACK, 'unexpected');
process.exitCode = 99;
`);
          fs.chmodSync(filename, 0o755);
        }
        const env = testChildEnvironment({ HOME: root, PATH: bin, CALLS: calls, FALLBACK: fallback });
        const runner = (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => (
          spawnSync(command, args, { ...options, env })
        );
        const options = {
          database: 'fixture', rootDir: root, dryRun: true, help: false,
          from: '2026-10-01', to: '2026-10-01',
        };
        const { runWrangler, wranglerArgsFor } = require(`../analytics-worker/${utility}.ts`);
        assert.deepEqual(runWrangler('SELECT 1', options, runner), [{ total: 1 }]);
        assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8')), wranglerArgsFor('SELECT 1', options));
        fs.rmSync(local);
        assert.throws(() => runWrangler('SELECT 1', options, runner), missingWranglerMessage);
        assert.isFalse(fs.existsSync(fallback));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
