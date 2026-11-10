const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { prepare } = require('./prepare-frozen-direct.cjs');
const here = __dirname;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-transport-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => cp.execFileSync('git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  for (const file of ['package.json', 'quickstart.sh', 'install.sh', 'commands/repo_update.ts']) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), file + '\n');
  }
  git(['add', '.']); git(['commit', '-m', 'Frozen fixture']);
  const artifact = path.join(root, 'artifact');
  const result = prepare(source, artifact);
  const run = (script, args, extra = {}) => cp.spawnSync('/bin/bash', [path.join(here, script), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const tools = {
    BALLIN_FROZEN_ROOT: artifact, BALLIN_FROZEN_SHA: result.sha,
    BALLIN_FROZEN_GIT: cp.execFileSync('/bin/bash', ['-c', 'type -P git'], { env, encoding: 'utf8' }).trim(),
    BALLIN_FROZEN_CURL: '/usr/bin/false',
  };
  return { root, source, artifact, sha: result.sha, git, run, tools };
}
test('prepares a clean frozen bundle/archive and verifies fixed checksums without running installers', t => {
  const f = fixture(t);
  const result = f.run('run-frozen-direct.sh', ['--verify', f.artifact, f.sha]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(cp.execFileSync('/usr/bin/tar', ['-tzf', path.join(f.artifact, 'source.tar.gz')], { encoding: 'utf8' }), /ballin-scripts\/quickstart.sh/);
  assert.equal(f.run('run-frozen-direct.sh', [f.artifact, f.sha]).status, 2);
});
test('rejects dirty source, existing output, wrong commit, tampering and manifest paths', t => {
  const f = fixture(t);
  assert.throws(() => prepare(f.source, f.artifact), /EEXIST/);
  fs.writeFileSync(path.join(f.source, 'untracked'), 'preserve');
  assert.throws(() => prepare(f.source, path.join(f.root, 'dirty')), /must be clean/);
  assert.notEqual(f.run('verify-frozen.sh', [f.artifact, 'f'.repeat(40)]).status, 0);
  fs.appendFileSync(path.join(f.artifact, 'bootstrap/install.sh'), 'tampered');
  assert.notEqual(f.run('verify-frozen.sh', [f.artifact, f.sha]).status, 0);
  fs.writeFileSync(path.join(f.artifact, 'SHA256SUMS'), '0'.repeat(64) + '  ../../other\n');
  assert.notEqual(f.run('verify-frozen.sh', [f.artifact, f.sha]).status, 0);
});
test('serves exact pinned bootstrap URLs; denies alternate refs and leaves unrelated downloads to curl', t => {
  const f = fixture(t), output = path.join(f.root, 'download');
  const raw = `https://raw.githubusercontent.com/JBallin/ballin-scripts/${f.sha}/install.sh`;
  const result = f.run('frozen-curl.sh', ['-q', '-sS', '-L', '-w', '%{http_code}', raw, '-o', output], f.tools);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '200');
  assert.equal(fs.readFileSync(output, 'utf8'), 'install.sh\n');
  for (const url of [raw.replace(f.sha, 'main'), raw.replace('install.sh', 'unknown'), 'https://api.github.com/repos/JBallin/ballin-scripts/releases/latest']) {
    assert.equal(f.run('frozen-curl.sh', [url, '-o', output], f.tools).status, 2);
  }
  assert.equal(f.run('frozen-curl.sh', ['https://example.invalid/install.sh', '-o', output], f.tools).status, 1);
});
test('real Git clone and exact fetch use the bundle while origin guards see canonical remote', t => {
  const f = fixture(t), installed = path.join(f.root, 'installed');
  const result = f.run('frozen-git.sh', ['clone', '--no-checkout', 'https://github.com/JBallin/ballin-scripts.git', installed], f.tools);
  assert.equal(result.status, 0, result.stderr);
  const origin = f.git(['-C', installed, 'remote', 'get-url', 'origin']).trim();
  assert.equal(origin, 'https://github.com/JBallin/ballin-scripts.git');
  const fetched = cp.spawnSync('/bin/bash', [path.join(here, 'frozen-git.sh'), 'fetch', '--no-tags', origin, f.sha], { cwd: installed, env: { PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...f.tools }, encoding: 'utf8' });
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(f.git(['-C', installed, 'rev-parse', 'FETCH_HEAD']).trim(), f.sha);
});
test('rejects a bundle/bootstrap identity mismatch before cloning installation destination', t => {
  const f = fixture(t), installed = path.join(f.root, 'installed');
  fs.appendFileSync(path.join(f.artifact, 'bootstrap/install.sh'), 'different');
  const result = f.run('frozen-git.sh', ['clone', '--no-checkout', 'https://github.com/JBallin/ballin-scripts.git', installed], f.tools);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(installed), false);
});
