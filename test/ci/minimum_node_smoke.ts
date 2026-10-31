const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');

if (process.argv[2] === '--probe') {
  // Load production modules only inside the supervisor's isolated environment.
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.BALLIN_TEST_CONFIG_PATH, path.join(process.env.HOME!, 'ballin.config.json'));
  const { isUtf8 } = require('node:buffer');
  const { createHash } = require('node:crypto');
  const { fetchConfig } = require('../../config/index.ts');
  const { readBoundedFile } = require('../../commands/recursive_snapshot.ts');
  const { readDirectorySnapshot } = require('../../commands/directory_snapshot.ts');

  assert.equal(typeof require('../../commands/ballin.ts').runBallinCli, 'function');
  assert.equal(fetchConfig().configObj.analytics.enabled, 'false');
  const bytes = readBoundedFile(path.join(process.env.HOME!, 'input.txt')).bytes;
  assert.equal(bytes.toString(), 'smoke\n');
  assert.equal(isUtf8(bytes), true);
  assert.equal(createHash('sha256').update('abc').digest('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const snapshot = Buffer.from(JSON.stringify({ format: 'ballin-directory', version: 2,
    entries: [{ path: 'sample.txt', executable: false, encoding: 'utf8', content: ['smoke\n'] }] }));
  assert.equal(readDirectorySnapshot(snapshot).entries[0].bytes.toString(), 'smoke\n');
} else {
  assert.equal(process.argv.length, 2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-minimum-node-'));
  try {
    const config = path.join(root, 'ballin.config.json');
    fs.copyFileSync(path.join(repo, 'config/.defaultConfig.json'), config);
    fs.writeFileSync(path.join(root, 'input.txt'), 'smoke\n');
    const env = {
      HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath), NODE_ENV: 'test',
      BALLIN_TEST_CONFIG_PATH: config, BALLIN_NO_ANALYTICS: '1', BALLIN_NO_COMMAND_ANALYTICS: '1',
    };
    const run = (args: string[]): string => {
      const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.match(run([path.join(repo, 'bin/ballin'), '--help']), /Usage: ballin/u);
    run([__filename, '--probe']);
    process.stdout.write(`Runtime smoke passed on ${process.version}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
