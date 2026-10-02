const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox, sandboxEnvironment, runSandbox, resetSandbox, resetRemote } = require('./helpers/onboarding.ts');
const { withEnvironment, testChildEnvironment } = require('./helpers/environment.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('onboarding sandbox', function() {
  this.timeout(20000);
  let sandbox: Sandbox;
  beforeEach(() => { sandbox = createSandbox(); });
  afterEach(() => { cleanupSandbox(sandbox.root); });
  const runNode = (script: string) => spawnSync(process.execPath, ['-e', script], {
    env: sandboxEnvironment(sandbox), cwd: sandbox.home, encoding: 'utf8', timeout: 3000,
  });
  const remote = () => JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));

  it('ignores poisoned credentials, startup hooks, Ballin overrides, and PATH', () => {
    const trap = path.join(sandbox.root, 'ambient-hook');
    const hook = path.join(sandbox.root, 'hook.js');
    fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(trap)}, 'escaped');`);
    withEnvironment({
      HOME: '/wrong-home', PATH: '/wrong-tools', GH_TOKEN: 'poison', GITHUB_TOKEN: 'poison', GH_HOST: 'poison',
      GH_CONFIG_DIR: '/wrong-auth', NODE_OPTIONS: `--require=${hook}`, BASH_ENV: hook, ENV: hook,
      BALLIN_TEST_CONFIG_PATH: '/wrong-config', BALLIN_BACKUP_HOST: 'poison', BALLIN_NO_ANALYTICS: '0',
    }, () => {
      const result = runNode('process.stdout.write(JSON.stringify(process.env))');
      assert.equal(result.status, 0, result.stderr);
      const env = JSON.parse(result.stdout);
      assert.equal(env.HOME, sandbox.home);
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'BASH_ENV', 'ENV', 'BALLIN_TEST_CONFIG_PATH', 'BALLIN_BACKUP_HOST']) assert.notProperty(env, key);
      assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    });
    assert.isFalse(fs.existsSync(trap));
  });

  it('refuses missing or changed safeguards before launching', () => {
    for (const file of [sandbox.guard, path.join(sandbox.tools, 'gh'), path.join(sandbox.tools, 'git')]) {
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, original + '\n// changed');
      assert.throws(() => runSandbox(sandbox, ['install'], 'y\n'), /safeguard was changed/u);
      fs.writeFileSync(file, original);
    }
    fs.unlinkSync(path.join(sandbox.tools, 'node'));
    assert.throws(() => runSandbox(sandbox, ['install'], 'y\n'), /Unexpected sandbox command/u);
    assert.isFalse(fs.existsSync(sandbox.repo));
  });

  it('rejects extra PATH commands and unowned installed shims', () => {
    const extra = path.join(sandbox.tools, 'curl');
    fs.writeFileSync(extra, 'uncontrolled');
    assert.throws(() => sandboxEnvironment(sandbox), /Unexpected sandbox command/u);
    fs.unlinkSync(extra);
    fs.writeFileSync(path.join(sandbox.bin, 'ballin'), 'uncontrolled');
    assert.throws(() => sandboxEnvironment(sandbox), /shim was changed/u);
  });

  it('refuses redirected checkout, remote state, and tool paths', () => {
    const outside = path.join(sandbox.root, 'other-checkout');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, sandbox.repo);
    assert.throws(() => runSandbox(sandbox, ['install'], 'y\n'), /checkout was replaced/u);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(sandbox.repo);
    const state = path.join(sandbox.remote, 'repository.json');
    const contents = fs.readFileSync(state, 'utf8');
    const other = path.join(outside, 'repository.json');
    fs.writeFileSync(other, contents);
    fs.unlinkSync(state);
    fs.symlinkSync(other, state);
    assert.throws(() => sandboxEnvironment(sandbox), /remote state was replaced/u);
    fs.unlinkSync(state);
    fs.writeFileSync(state, contents);
    fs.unlinkSync(other);
    fs.unlinkSync(state);
    fs.symlinkSync(other, state);
    assert.throws(() => resetRemote(sandbox), /remote state was replaced/u);
    assert.isFalse(fs.existsSync(other));
    fs.unlinkSync(state);
    fs.writeFileSync(state, contents);
    fs.rmSync(outside, { recursive: true });
    fs.symlinkSync(outside, sandbox.repo);
    assert.throws(() => sandboxEnvironment(sandbox), /checkout was replaced/u);
    fs.unlinkSync(sandbox.repo);
    const bash = path.join(sandbox.tools, 'bash');
    fs.unlinkSync(bash);
    fs.symlinkSync(process.execPath, bash);
    assert.throws(() => sandboxEnvironment(sandbox), /tool was changed: bash/u);
  });

  it('blocks direct Node network paths and uncontrolled child execution', () => {
    for (const operation of [
      "require('https').get('https://example.invalid')", "require('http').request('http://example.invalid')",
      "require('net').connect(443, 'example.invalid')", "require('tls').connect(443, 'example.invalid')",
      "require('dgram').createSocket('udp4')", "fetch('https://example.invalid')",
      "require('dns').lookup('example.invalid', () => {})", "require('dns').promises.resolve('example.invalid')",
      "require('child_process').spawnSync('/usr/bin/git', ['--version'])",
      "require('child_process').spawnSync('bash', ['-c', 'true'], {env: {HOME: '/wrong'}})",
      "require('child_process').execSync('true')",
    ]) {
      const result = runNode(operation);
      assert.equal(result.status, 1, operation);
      assert.include(result.stderr, 'sandbox safeguard refused');
    }
  });

  it('fails unknown Git and GitHub operations rather than simulating success', () => {
    const env = sandboxEnvironment(sandbox);
    for (const args of [['fetch', 'evil'], ['checkout', 'evil'], ['merge', '--abort'], ['stash', 'drop'], ['rev-parse', 'HEAD']]) {
      const result = spawnSync(path.join(sandbox.tools, 'git'), args, { cwd: sandbox.home, env });
      assert.equal(result.status, 2, args.join(' '));
    }
    const result = spawnSync(path.join(sandbox.tools, 'gh'), ['auth', 'login'], { cwd: sandbox.home, env });
    assert.notEqual(result.status, 0);
    assert.isFalse(remote().exists);
  });

  it('reuses an install for later opt-in and clean create/reconnect walkthrough resets', () => {
    assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    assert.isTrue(fs.existsSync(path.join(sandbox.repo, 'completions/_ballin')));
    const setup = runSandbox(sandbox, ['backup', 'setup'], 'y\ncreate\n\ny\ny\n\n');
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.include(setup.stdout, 'sensitive sources');
    assert.include(setup.stdout, 'Automatically');
    assert.isTrue(remote().exists);
    resetSandbox(sandbox, 'reconnect');
    const config = () => JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.isNull(config().backup.repository);
    assert.equal(config().backup.includeSensitive, 'false');
    const reconnect = runSandbox(sandbox, ['backup', 'setup'], 'y\nreconnect\n\nn\ny\nn\n');
    assert.equal(reconnect.status, 0, reconnect.stdout + reconnect.stderr);
    assert.isNotNull(config().backup.repository);
    assert.isFalse(remote().requests.some((request: { endpoint: string }) => request.endpoint === 'user/repos'));
    resetSandbox(sandbox, 'create');
    assert.isFalse(remote().exists);
    assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.backup-cache')));
    assert.isNull(config().backup.repository);
    resetSandbox(sandbox, 'fresh');
    assert.isFalse(fs.existsSync(sandbox.repo));
    assert.isFalse(fs.existsSync(path.join(sandbox.bin, 'ballin')));
  });

  it('rejects invalid, linked, and active cleanup roots', () => {
    assert.throws(() => cleanupSandbox(sandbox.home), /unverified/u);
    const marker = path.join(sandbox.root, '.ballin-onboarding-sandbox.json');
    const original = fs.readFileSync(marker, 'utf8');
    fs.writeFileSync(marker, '{}');
    assert.throws(() => cleanupSandbox(sandbox.root), /Invalid/u);
    fs.writeFileSync(marker, original);
    const link = path.join(sandbox.root, 'ballin-onboarding-link');
    fs.symlinkSync(sandbox.root, link);
    assert.throws(() => cleanupSandbox(link), /unverified/u);
    const active = path.join(sandbox.root, '.active');
    fs.writeFileSync(active, String(process.pid));
    assert.throws(() => cleanupSandbox(sandbox.root), /still running/u);
    fs.unlinkSync(active);
  });
});

describe('interactive onboarding QA lifecycle', function() {
  this.timeout(20000);
  const cli = path.join(__dirname, 'onboarding_qa.ts');
  const roots: string[] = [];
  const findRoot = (output: string): string => {
    const root = output.match(/Ballin onboarding sandbox: (.+)/u)?.[1];
    assert.exists(root, output);
    roots.push(root as string);
    return root as string;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) if (fs.existsSync(root)) cleanupSandbox(root);
  });
  const run = (input: string, args: string[] = []) => spawnSync(process.execPath, [cli, ...args], {
    input, env: testChildEnvironment(), cwd: path.dirname(cli), encoding: 'utf8', timeout: 10000,
  });
  it('runs actual installer and setup prompts, inspects fake state, and preserves explicitly', () => {
    const result = run('y\nn\nn\nballin backup setup\ny\ncreate\n\nn\ny\nn\ninspect\nreset reconnect\nballin backup setup\ny\nreconnect\n\nn\ny\nn\nexit\n', ['--keep']);
    const root = findRoot(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Proceed with installation?');
    assert.include(result.stdout, 'Fake repository: fixture-user/ballin-backups');
    assert.include(result.stdout, 'Preserved sandbox:');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'remote/repository.json'), 'utf8'));
    assert.isTrue(state.exists);
    assert.isFalse(state.requests.some((request: { endpoint: string }) => request.endpoint === 'user/repos'));
    const cleanup = run('', ['--cleanup', root]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.isFalse(fs.existsSync(root));
  });
  it('cleans normal exit and EOF without waiting for more input', () => {
    for (const input of ['n\nexit\n', '']) {
      const result = run(input);
      const root = findRoot(result.stdout);
      assert.equal(result.status, 0, result.stderr);
      assert.isFalse(fs.existsSync(root));
      assert.include(result.stdout, 'Onboarding sandbox removed.');
    }
  });
  it('preserves failed commands for inspection', () => {
    const result = run('y\nn\nn\nballin backup\nexit\n');
    const root = findRoot(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.isTrue(fs.existsSync(root));
    assert.include(result.stdout, 'sandbox will be preserved');
  });
  it('preserves an EOF-cancelled setup without creating a fake destination', () => {
    const result = run('y\nn\nn\nballin backup setup\ny\ncreate\n\n');
    const root = findRoot(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Backup setup cancelled');
    assert.include(result.stdout, 'Preserved sandbox:');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'remote/repository.json'), 'utf8'));
    assert.isFalse(state.exists);
    assert.isFalse(state.requests.some((request: { endpoint: string }) => request.endpoint === 'user/repos'));
  });
  it('stops an interrupted installer before releasing the sandbox session', async () => {
    const child = spawn(process.execPath, [cli], { env: testChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let signalled = false;
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      if (!signalled && output.includes('Proceed with installation?')) {
        signalled = true;
        child.kill('SIGINT');
      }
    });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const root = findRoot(output);
    assert.equal(status, 130, output);
    assert.isTrue(fs.existsSync(root));
    assert.isFalse(fs.existsSync(path.join(root, '.active')));
    assert.isFalse(fs.existsSync(path.join(root, 'home/.ballin-scripts')));
  });
});
