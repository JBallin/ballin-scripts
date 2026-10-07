const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createSandbox, cleanupSandbox, sandboxEnvironment, runSandbox, resetSandbox, resetRemote, sandboxSuiteTimeout, recordSession, processIsAlive } = require('./helpers/onboarding.ts');
const { withEnvironment, testChildEnvironment } = require('./helpers/environment.ts');
import type { Sandbox } from './helpers/onboarding.ts';

const waitForGroupExit = async (group: number): Promise<void> => {
  const deadline = Date.now() + 10000;
  while (processIsAlive(-group)) {
    if (Date.now() >= deadline) throw new Error('Fixture child process group did not exit');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('onboarding sandbox', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  beforeEach(() => { sandbox = createSandbox(); });
  afterEach(() => { if (fs.existsSync(sandbox.root)) cleanupSandbox(sandbox.root); });
  const runNode = (script: string) => spawnSync(process.execPath, ['-e', script], {
    env: sandboxEnvironment(sandbox), cwd: sandbox.home, encoding: 'utf8', timeout: 10000,
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
    for (const file of [sandbox.guard, path.join(sandbox.tools, 'gh'), path.join(sandbox.tools, 'git'), path.join(sandbox.tools, 'softwareupdate')]) {
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, original + '\n// changed');
      assert.throws(() => runSandbox(sandbox, ['install'], 'y\n'), /safeguard was changed/u);
      fs.writeFileSync(file, original);
    }
    const systemUpdate = path.join(sandbox.tools, 'softwareupdate');
    const contents = fs.readFileSync(systemUpdate, 'utf8');
    fs.unlinkSync(systemUpdate);
    assert.throws(() => runSandbox(sandbox, ['install'], 'y\n'), /Unexpected sandbox command/u);
    fs.writeFileSync(systemUpdate, contents, { mode: 0o755 });
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
    const systemUpdate = spawnSync(path.join(sandbox.tools, 'softwareupdate'), ['--list'], { cwd: sandbox.home, env, encoding: 'utf8' });
    assert.equal(systemUpdate.status, 2);
    assert.include(systemUpdate.stderr, 'Unsupported sandbox softwareupdate operation');
    assert.isFalse(remote().exists);
  });

  it('runs maintenance with fresh installation defaults and the guarded installed self-update path', () => {
    assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.equal(config.update.selfUpdate, 'true');
    const update = runSandbox(sandbox, ['update']);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    assert.include(update.stdout, 'Checking Ballin readiness');
    assert.include(update.stdout, "You're ballin.");
    assert.include(fs.readFileSync(sandbox.log, 'utf8'), 'git:fetch --quiet origin +main:refs/remotes/origin/main');
    assert.include(fs.readFileSync(sandbox.log, 'utf8'), 'softwareupdate:-ia');
    assert.isEmpty(remote().requests);
  });

  it('runs self-update and automatic backup through the real guarded installed CLI', () => {
    const install = runSandbox(sandbox, ['install'], 'y\nn\ny\ncreate\n\ny\ny\ny\n');
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
    assert.equal(config.update.selfUpdate, 'true');
    assert.equal(config.update.backup, 'true');
    const update = runSandbox(sandbox, ['update']);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    assert.include(update.stdout, 'Checking Ballin readiness');
    assert.include(update.stdout, 'Backing up development environment');
    assert.include(update.stdout, '✚ zshrc');
    const state = remote();
    assert.equal(Buffer.from(state.commits[state.head].files['zshrc.sh'], 'base64').toString(), fs.readFileSync(path.join(sandbox.home, '.zshrc'), 'utf8'));
    assert.lengthOf(state.requests.filter((request: { payload?: { query?: string } }) => request.payload?.query?.includes('BallinPublish')), 2);
  });

  it('refuses sibling executables and redirected targets beside the exact installed CLI', () => {
    assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    const executable = path.join(sandbox.repo, 'bin/ballin');
    const sibling = path.join(sandbox.repo, 'bin/other');
    fs.symlinkSync(executable, sibling);
    const siblingResult = runNode(`require('child_process').spawnSync(${JSON.stringify(sibling)}, ['--help'])`);
    assert.equal(siblingResult.status, 1);
    assert.include(siblingResult.stderr, 'sandbox safeguard refused');
    const outside = path.join(sandbox.root, 'other-ballin');
    fs.copyFileSync(executable, outside);
    fs.unlinkSync(executable);
    fs.symlinkSync(outside, executable);
    const redirected = runNode(`require('child_process').spawnSync(${JSON.stringify(executable)}, ['--help'])`);
    assert.equal(redirected.status, 1);
    assert.include(redirected.stderr, 'sandbox safeguard refused');
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
    recordSession(sandbox, []);
    assert.throws(() => cleanupSandbox(sandbox.root), /still running/u);
    fs.unlinkSync(active);
  });

  it('retains ownership of descendants after their process-group leader exits', async () => {
    const script = "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); child.unref();";
    const leader = spawn(process.execPath, ['-e', script], {
      cwd: sandbox.home, env: sandboxEnvironment(sandbox), detached: true, stdio: 'ignore',
    });
    const group = leader.pid as number;
    let stopped = false;
    try {
      await new Promise((resolve, reject) => { leader.once('error', reject); leader.once('close', resolve); });
      assert.isFalse(processIsAlive(group));
      assert.isTrue(processIsAlive(-group));
      const active = path.join(sandbox.root, '.active');
      fs.writeFileSync(active, JSON.stringify({ parent: group, groups: [group], launchPending: false }));
      assert.throws(() => cleanupSandbox(sandbox.root), /child process group is still running/u);
      assert.isTrue(fs.existsSync(sandbox.root));
      process.kill(-group, 'SIGTERM');
      await waitForGroupExit(group);
      stopped = true;
      cleanupSandbox(sandbox.root);
      assert.isFalse(fs.existsSync(sandbox.root));
    } finally {
      if (!stopped) {
        try { process.kill(-group, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForGroupExit(group);
      }
    }
  });

  it('stops the entire synchronous command group before timeout teardown', () => {
    assert.equal(runSandbox(sandbox, ['install'], 'y\nn\nn\n').status, 0);
    const childPid = path.join(sandbox.scratch, 'timeout-child.pid');
    fs.writeFileSync(path.join(sandbox.repo, 'bin/ballin'), `#!/usr/bin/env node\nconst {spawn}=require('child_process'); const fs=require('fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(childPid)},String(child.pid)); setInterval(()=>{},1000);`, { mode: 0o755 });
    assert.throws(() => runSandbox(sandbox, ['update'], undefined, 2000), /exceeded the 2000ms test timeout/u);
    assert.isFalse(processIsAlive(Number(fs.readFileSync(childPid, 'utf8'))));
    assert.isFalse(fs.existsSync(path.join(sandbox.root, '.active')));
  });

  it('refuses ambiguous launch and malformed or legacy session markers', () => {
    const active = path.join(sandbox.root, '.active');
    for (const session of ['not JSON', '123', JSON.stringify({ parent: process.pid, groups: [-1], launchPending: false })]) {
      fs.writeFileSync(active, session);
      assert.throws(() => cleanupSandbox(sandbox.root));
      assert.isTrue(fs.existsSync(sandbox.root));
    }
    fs.unlinkSync(active);
  });
});

describe('interactive onboarding QA lifecycle', function() {
  this.timeout(sandboxSuiteTimeout);
  const cli = path.join(__dirname, 'qa_sandbox.ts');
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
  const run = (input: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
    input, env: testChildEnvironment(), cwd: path.dirname(cli), encoding: 'utf8', timeout: 240000,
    });
    if (result.error?.code === 'ETIMEDOUT') throw new Error('Interactive QA fixture exceeded its 240000ms test timeout');
    return result;
  };
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
  it('keeps a cancelled installation usable for inspection, install, and later commands', () => {
    const result = run('n\nballin backup\ninspect\ninstall\ny\nn\nn\nballin doctor --verbose\nexit\n');
    const root = findRoot(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Installation cancelled');
    assert.include(result.stdout, 'Ballin is not installed in this sandbox. Run install, then retry this command.');
    assert.include(result.stdout, 'Fake repository: (not created)');
    assert.include(result.stdout, 'Ballin doctor');
    assert.include(result.stdout, 'Onboarding sandbox removed.');
    assert.notInclude(result.stderr, 'ENOENT');
    assert.isFalse(fs.existsSync(root));
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
    const active = path.join(root, '.active');
    if (fs.existsSync(active)) {
      const session = JSON.parse(fs.readFileSync(active, 'utf8'));
      for (const group of session.groups) await waitForGroupExit(group);
    }
    assert.isFalse(fs.existsSync(path.join(root, 'home/.ballin-scripts')));
  });

  it('refuses cleanup after parent SIGKILL until its orphaned process group exits', async () => {
    const wrapperScript = `const {spawn} = require('child_process'); const qa = spawn(process.execPath, [${JSON.stringify(cli)}], {stdio:'inherit'}); process.stdout.write('QA_PARENT:' + qa.pid + '\\n'); qa.on('exit', () => process.stdout.write('QA_EXITED\\n')); setInterval(() => {}, 1000);`;
    const wrapper = spawn(process.execPath, ['-e', wrapperScript], { env: testChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let root = '';
    let group = 0;
    const closed = new Promise((resolve) => wrapper.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Installer prompt did not arrive within 120 seconds')), 120000);
        const finish = (error?: Error): void => { clearTimeout(timer); if (error) reject(error); else resolve(); };
        wrapper.once('error', finish);
        wrapper.once('close', () => finish(new Error('Fixture wrapper exited before installer prompt')));
        wrapper.stdout.on('data', (bytes: Buffer) => {
          output += bytes.toString();
          if (output.includes('QA_EXITED')) finish(new Error('Fixture QA exited before installer prompt'));
          if (output.includes('Proceed with installation?')) finish();
        });
      });
      root = findRoot(output);
      const session = JSON.parse(fs.readFileSync(path.join(root, '.active'), 'utf8'));
      group = session.groups[0];
      assert.isFalse(session.launchPending);
      assert.equal(session.parent, Number(output.match(/QA_PARENT:(\d+)/u)?.[1]));
      process.kill(session.parent, 'SIGKILL');
      const deadline = Date.now() + 10000;
      while (processIsAlive(session.parent)) {
        if (Date.now() > deadline) throw new Error('Fixture QA parent did not exit');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.isTrue(processIsAlive(-group));
      assert.throws(() => cleanupSandbox(root), /child process group is still running/u);
      assert.isTrue(fs.existsSync(root));
      process.kill(-group, 'SIGTERM');
      await waitForGroupExit(group);
      fs.writeFileSync(path.join(root, '.active'), JSON.stringify({ ...session, launchPending: true }));
      assert.throws(() => cleanupSandbox(root), /launch state is ambiguous/u);
      fs.writeFileSync(path.join(root, '.active'), JSON.stringify(session));
      cleanupSandbox(root);
      assert.isFalse(fs.existsSync(root));
    } finally {
      const qaParent = Number(output.match(/QA_PARENT:(\d+)/u)?.[1]);
      if (!root && output.includes('Ballin onboarding sandbox:')) root = findRoot(output);
      const active = root && path.join(root, '.active');
      const groups: number[] = active && fs.existsSync(active)
        ? JSON.parse(fs.readFileSync(active, 'utf8')).groups : group ? [group] : [];
      if (qaParent && processIsAlive(qaParent)) process.kill(qaParent, 'SIGKILL');
      for (const ownedGroup of groups) {
        if (processIsAlive(-ownedGroup)) process.kill(-ownedGroup, 'SIGKILL');
        await waitForGroupExit(ownedGroup);
      }
      wrapper.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture wrapper did not close')), 10000);
        })]);
      } finally { clearTimeout(timer); }
    }
  });

  it('runs all controlled stubs with a real Node executable and temp root containing whitespace', () => {
    const host = createSandbox();
    const temporary = path.join(host.root, 'temporary space "quoted" \'single\' \\slash');
    const interpreter = path.join(host.root, 'node runtime/node');
    fs.mkdirSync(temporary);
    fs.mkdirSync(path.dirname(interpreter));
    fs.copyFileSync(process.execPath, interpreter, fs.constants.COPYFILE_FICLONE);
    const env = testChildEnvironment({ TMPDIR: temporary });
    let root = '';
    try {
      const actualPath = spawnSync(interpreter, ['-p', 'process.execPath'], { env, encoding: 'utf8' });
      assert.equal(actualPath.status, 0, actualPath.stderr);
      assert.equal(actualPath.stdout.trim(), interpreter);
      const result = spawnSync(interpreter, [cli, '--keep'], {
        env, encoding: 'utf8', timeout: 240000,
        input: 'y\nn\nn\nballin backup setup\ny\ncreate\n\nn\ny\ny\nballin update\nexit\n',
      });
      root = findRoot(result.stdout);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Command exited');
      assert.include(result.stdout, 'Simulated macOS update');
      assert.include(result.stdout, 'Backing up development environment');
      for (const name of ['git', 'gh', 'softwareupdate']) {
        assert.match(fs.readFileSync(path.join(root, 'tools', name), 'utf8'), /^#!\/usr\/bin\/env node\n/u);
      }
      const quotedRoot = `'${root.replaceAll("'", "'\"'\"'")}'`;
      assert.include(result.stdout, `Cleanup: npm run sandbox -- --cleanup ${quotedRoot}`);
      const cleanup = spawnSync(interpreter, [cli, '--cleanup', root], { env, encoding: 'utf8', timeout: 10000 });
      assert.equal(cleanup.status, 0, cleanup.stderr);
      assert.isFalse(fs.existsSync(root));
    } finally {
      withEnvironment({ TMPDIR: temporary }, () => { if (root && fs.existsSync(root)) cleanupSandbox(root); });
      cleanupSandbox(host.root);
    }
  });
});
