const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const helper = path.resolve(__dirname, '../commands/repo_update.ts');

describe('selected checkout integration', () => {
  let root: string, upstream: string, installed: string, before: string, target: string, preload: string;
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }) });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-checkout-test-')); upstream = path.join(root, 'source'); installed = path.join(root, 'installed'); fs.mkdirSync(upstream);
    git(upstream, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(upstream, '.gitignore'), 'ballin.config.json\n.backup-cache\n.analytics\n');
    fs.writeFileSync(path.join(upstream, 'installer-contract.json'), JSON.stringify({ protocol: 1, minimumNode: '24.12.0' }));
    for (const entry of ['install.sh', 'quickstart.sh', 'commands/repo_update.ts', 'commands/install_setup.ts', 'bin/ballin', 'package.json']) {
      const file = path.join(upstream, entry); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture\n');
    }
    fs.writeFileSync(path.join(upstream, 'content'), 'before'); git(upstream, ['add', '.']); git(upstream, ['commit', '-qm', 'before']); before = git(upstream, ['rev-parse', 'HEAD']);
    git(root, ['clone', '-q', upstream, installed]); git(installed, ['remote', 'set-url', 'origin', 'https://github.com/JBallin/ballin-scripts.git']);
    fs.writeFileSync(path.join(upstream, 'content'), 'after'); git(upstream, ['commit', '-qam', 'after']); target = git(upstream, ['rev-parse', 'HEAD']); git(upstream, ['tag', 'v1.0.0']);
    fs.writeFileSync(path.join(installed, 'ballin.config.json'), '{"preserve":true}'); fs.mkdirSync(path.join(installed, '.analytics')); fs.writeFileSync(path.join(installed, '.analytics/install-id'), 'preserved');
    preload = path.join(root, 'network.cjs');
    fs.writeFileSync(preload, `const cp=require('child_process'),original=cp.spawnSync;cp.spawnSync=function(command,args,options){if(command==='git'&&args[0]==='fetch'){require('fs').appendFileSync(${JSON.stringify(path.join(root, 'fetches'))},args.join(' ')+'\\n');if(process.env.FIXTURE_FETCH_STATUS)return {status:Number(process.env.FIXTURE_FETCH_STATUS),stderr:'fixture failure'};args=args.map(a=>a==='https://github.com/JBallin/ballin-scripts.git'?${JSON.stringify(upstream)}:a);}return original(command,args,options);};require('tty').isatty=()=>process.env.FIXTURE_TTY==='1';`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (options: { sha?: string; kind?: string; value?: string; minimum?: string; mode?: string; input?: string; env?: NodeJS.ProcessEnv; fresh?: boolean } = {}) => spawnSync(process.execPath, [helper, 'apply', installed, options.kind || 'sha', options.value || options.sha || target, options.sha || target, options.minimum || '24.12.0', options.kind === 'release' ? '123' : '-', options.mode || 'install', String(options.fresh ?? false)], {
    encoding: 'utf8', input: options.input ?? 'yes\n', env: testChildEnvironment({ HOME: root, PATH: process.env.PATH, NODE_OPTIONS: `--require=${preload}`, FIXTURE_TTY: '1', ...options.env }), timeout: 10000,
  });
  it('checks out exactly the selected SHA and preserves local data', () => {
    const r = run(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(git(installed, ['rev-parse', 'HEAD']), target);
    assert.equal(fs.readFileSync(path.join(installed, 'ballin.config.json'), 'utf8'), '{"preserve":true}'); assert.equal(fs.readFileSync(path.join(installed, '.analytics/install-id'), 'utf8'), 'preserved');
    const receipt = JSON.parse(fs.readFileSync(path.join(installed, '.git/ballin-install.json'), 'utf8')); assert.equal(receipt.kind, 'sha'); assert.equal(receipt.sha, target);
  });
  it('installs into a fresh clone without checking out its default branch first', () => {
    installed = path.join(root, 'fresh'); git(root, ['clone', '-q', '--no-checkout', upstream, installed]);
    git(installed, ['remote', 'set-url', 'origin', 'https://github.com/JBallin/ballin-scripts.git']);
    assert.isFalse(fs.existsSync(path.join(installed, 'content')));
    const r = run({ fresh: true, input: '' }); assert.equal(r.status, 0, r.stderr);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), target); assert.equal(fs.readFileSync(path.join(installed, 'content'), 'utf8'), 'after');
    assert.notInclude(r.stdout, 'Change the installed revision');
  });
  it('refuses a fetched incompatible contract before changing HEAD', () => {
    fs.writeFileSync(path.join(upstream, 'installer-contract.json'), JSON.stringify({ protocol: '1', minimumNode: '24.12.0' }));
    git(upstream, ['commit', '-qam', 'incompatible contract']);
    const r = run({ sha: git(upstream, ['rev-parse', 'HEAD']) }); assert.equal(r.status, 1); assert.include(r.stderr, 'contract changed or is unsupported');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('exposes read-only inspection and rejects unknown CLI actions', () => {
    const env = testChildEnvironment({ HOME: root, PATH: process.env.PATH, NODE_OPTIONS: `--require=${preload}` });
    for (const action of ['inspect', 'unknown']) {
      const r = spawnSync(process.execPath, [helper, action, installed], { encoding: 'utf8', env });
      assert.equal(r.status, action === 'inspect' ? 0 : 1, r.stderr);
      if (action === 'unknown') assert.include(r.stderr, 'Usage:');
    }
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.isFalse(fs.existsSync(path.join(root, 'fetches')));
  });
  for (const input of ['no\n', '', 'y', 'yes' + ' '.repeat(40) + 'no\n']) it(`refuses an unconfirmed transition (${JSON.stringify(input)})`, () => {
    const r = run({ input }); assert.equal(r.status, 1); assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.include(r.stderr, 'cancelled');
  });
  it('refuses automatic track changes even with a terminal', () => {
    const r = run({ env: { BALLIN_AUTOMATIC_UPDATE: '1' }, mode: 'self-update' }); assert.equal(r.status, 1); assert.include(r.stderr, 'requires confirmation'); assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('refuses noninteractive revision changes even with affirmative input', () => {
    const r = run({ env: { FIXTURE_TTY: '0' }, input: 'yes\n' }); assert.equal(r.status, 1); assert.include(r.stderr, 'requires confirmation');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('rejects inconsistent selected runtime metadata before changing checkout', () => {
    const r = run({ minimum: '24.12.1' }); assert.equal(r.status, 1); assert.include(r.stderr, 'contract changed or is unsupported');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('reports an unavailable updater launcher without changing checkout', () => {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(helper)}).updateInstalledRepo(process.argv[1])`, installed], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: '', NODE_OPTIONS: `--require=${preload}` }),
    });
    assert.equal(r.status, 1); assert.include(r.stderr, 'Unable to start the installed updater');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.isFalse(fs.existsSync(path.join(root, 'fetches')));
  });
  it('checks minimum runtime before fetching or changing HEAD', () => {
    const r = run({ minimum: '999.0.0' }); assert.equal(r.status, 1); assert.include(r.stderr, 'requires Node.js'); assert.isFalse(fs.existsSync(path.join(root, 'fetches'))); assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('refuses dirty checkout without fetching or stashing', () => {
    fs.writeFileSync(path.join(installed, 'content'), 'user work'); const r = run(); assert.equal(r.status, 1); assert.isFalse(fs.existsSync(path.join(root, 'fetches'))); assert.equal(fs.readFileSync(path.join(installed, 'content'), 'utf8'), 'user work');
  });
  it('rejects replacement refs before fetching and never reports replacement content as a release', () => {
    git(installed, ['fetch', '-q', upstream, target]); git(installed, ['replace', before, target]);
    const r = run(); assert.equal(r.status, 1); assert.include(r.stderr, 'replacement refs'); assert.isFalse(fs.existsSync(path.join(root, 'fetches')));
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.equal(fs.readFileSync(path.join(installed, 'content'), 'utf8'), 'before');
    git(installed, ['tag', 'v1.0.0', before]);
    fs.writeFileSync(path.join(installed, '.git/ballin-install.json'), JSON.stringify({ kind: 'release', value: 'v1.0.0', sha: before, minimumNode: '24.12.0', releaseId: '123' }));
    assert.equal(require('../commands/repo_update.ts').readIdentity(installed).version, 'development');
  });
  it('refuses missing required setup before changing checkout or receipt', () => {
    git(upstream, ['rm', 'commands/install_setup.ts']); git(upstream, ['commit', '-qm', 'unsupported layout']);
    const r = run({ sha: git(upstream, ['rev-parse', 'HEAD']) }); assert.equal(r.status, 1); assert.include(r.stderr, 'lacks a supported installer file');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.isFalse(fs.existsSync(path.join(installed, '.git/ballin-install.json')));
  });
  it('reports actual checkout and incomplete setup when receipt storage fails', () => {
    fs.mkdirSync(path.join(installed, '.git/ballin-install.json'));
    const r = run(); assert.equal(r.status, 1); assert.include(r.stderr, `Checkout is now ${target}`); assert.include(r.stderr, 'setup is incomplete');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), target); assert.equal(require('../commands/repo_update.ts').readIdentity(installed).version, 'development');
  });
  it('verifies the selected tag and records release provenance', () => {
    const r = run({ kind: 'release', value: 'v1.0.0' }); assert.equal(r.status, 0, r.stderr); assert.equal(git(installed, ['rev-parse', 'v1.0.0^{commit}']), target);
    assert.equal(require('../commands/repo_update.ts').readIdentity(installed).version, '1.0.0');
  });
  it('refuses a conflicting local tag', () => {
    git(installed, ['tag', 'v1.0.0']); const r = run({ kind: 'release', value: 'v1.0.0' }); assert.equal(r.status, 1); assert.include(r.stderr, 'conflicts'); assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
  it('refuses a remote tag that moved after release resolution', () => {
    git(upstream, ['tag', '-f', 'v1.0.0', before]);
    const r = run({ kind: 'release', value: 'v1.0.0' }); assert.equal(r.status, 1); assert.include(r.stderr, 'tag moved');
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.isFalse(fs.existsSync(path.join(installed, '.git/ballin-install.json')));
  });
  it('fast-forwards main and explicitly permits a confirmed backward install', () => {
    let r = run({ kind: 'branch', value: 'main' }); assert.equal(r.status, 0, r.stderr);
    assert.equal(git(installed, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    r = run({ kind: 'branch', value: 'main', sha: before }); assert.equal(r.status, 0, r.stderr);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
    assert.equal(git(installed, ['rev-parse', 'refs/heads/main']), target);
  });
  it('refuses automatic main rewind and divergence without changing local work', () => {
    assert.equal(run({ kind: 'branch', value: 'main' }).status, 0);
    let r = run({ kind: 'branch', value: 'main', sha: before, mode: 'self-update' });
    assert.equal(r.status, 1); assert.include(r.stderr, 'moved backward'); assert.equal(git(installed, ['rev-parse', 'HEAD']), target);
    git(upstream, ['checkout', '-q', '--detach', before]); fs.writeFileSync(path.join(upstream, 'content'), 'different'); git(upstream, ['commit', '-qam', 'divergent']);
    const divergent = git(upstream, ['rev-parse', 'HEAD']);
    r = run({ kind: 'branch', value: 'main', sha: divergent, mode: 'self-update' });
    assert.equal(r.status, 1); assert.include(r.stderr, 'diverged'); assert.equal(git(installed, ['rev-parse', 'HEAD']), target);
  });
  it('refuses an ignored user-data collision and preserves bytes', () => {
    fs.writeFileSync(path.join(upstream, 'ballin.config.json'), 'incoming tracked file');
    git(upstream, ['add', '-f', 'ballin.config.json']); git(upstream, ['commit', '-qm', 'collision']);
    const r = run({ sha: git(upstream, ['rev-parse', 'HEAD']) }); assert.equal(r.status, 1);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
    assert.equal(fs.readFileSync(path.join(installed, 'ballin.config.json'), 'utf8'), '{"preserve":true}');
  });
  it('does not silently equate a SHA install with the release on that commit', () => {
    assert.equal(run({ kind: 'release', value: 'v1.0.0' }).status, 0);
    assert.equal(run().status, 0);
    assert.equal(require('../commands/repo_update.ts').readIdentity(installed).version, 'development');
  });
  for (const status of [1, 130, 143]) it(`preserves fetch failure/interruption ${status}`, () => {
    const r = run({ env: { FIXTURE_FETCH_STATUS: String(status) } }); assert.equal(r.status, status); assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
  });
});
