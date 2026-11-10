const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createPackageSourceFixture } = require('./helpers/package_source.ts');
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');

for (const layout of ['copied keg', 'source modules']) describe(`explicit Homebrew initial setup (${layout})`, () => {
  let root: string;
  let home: string;
  let repo: string;
  let file: string;
  let tools: string;
  let markerPath: string;
  let packageEnv: NodeJS.ProcessEnv;
  const run = (input = '', args = ['setup', '--initial']) => spawnSync(process.execPath, [path.join(repo, 'bin/ballin'), ...args], {
    input, encoding: 'utf8', timeout: 15000,
    env: { HOME: home, PATH: tools, NO_COLOR: '1', TERM: 'dumb', BALLIN_NO_ANALYTICS: '1', ...packageEnv },
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-package-setup-'));
    home = path.join(root, 'home'); tools = path.join(root, 'tools');
    for (const dir of [home, tools]) fs.mkdirSync(dir);
    const source = path.join(__dirname, '..');
    packageEnv = {};
    if (layout === 'copied keg') {
      repo = path.join(root, 'keg');
      fs.mkdirSync(repo);
      for (const entry of ['commands', 'config', 'bin', 'package.json']) fs.cpSync(path.join(source, entry), path.join(repo, entry), { recursive: true });
      markerPath = path.join(repo, '.ballin-package.json');
    } else {
      repo = source;
      const fixture = createPackageSourceFixture(root, repo);
      markerPath = fixture.markerPath;
      packageEnv = fixture.env;
    }
    fs.writeFileSync(markerPath, JSON.stringify({ manager: 'homebrew', schema: 2, formula: 'ballin-experiment', version: require('../package.json').version, sourceRevision: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), selection: { kind: 'development' }, commandPath: path.join(tools, 'ballin'), completionRoot: path.join(repo, 'completions') }));
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    for (const name of ['gh', 'git']) fs.writeFileSync(path.join(tools, name), `#!/bin/sh\nprintf '${name}\\n' >> '${root}/unexpected'\nexit 99\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, '.zshrc'), 'keep startup\n');
    fs.mkdirSync(path.join(home, '.ballin-scripts'));
    fs.writeFileSync(path.join(home, '.ballin-scripts/ballin.config.json'), 'keep Git config');
    fs.symlinkSync(path.join(repo, 'bin/ballin'), path.join(tools, 'ballin'));
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.symlinkSync(path.join(home, '.ballin-scripts/bin/ballin'), path.join(home, '.local/bin/ballin'));
    file = path.join(home, '.ballin/ballin.config.json');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const assertUntouched = () => {
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'keep startup\n');
    assert.equal(fs.readFileSync(path.join(home, '.ballin-scripts/ballin.config.json'), 'utf8'), 'keep Git config');
    assert.equal(fs.readlinkSync(path.join(tools, 'ballin')), path.join(repo, 'bin/ballin'));
    assert.equal(fs.readlinkSync(path.join(home, '.local/bin/ballin')), path.join(home, '.ballin-scripts/bin/ballin'));
    assert.isFalse(fs.existsSync(path.join(repo, 'ballin.config.json')));
    assert.isFalse(fs.existsSync(path.join(root, 'unexpected')));
  };
  for (const prompt of ['backup', 'preferences']) for (const failure of ['EAGAIN', 'EIO', 'unknown', '130', '143']) {
    it(`contains ${prompt} consent input failure ${failure} without changing saved state`, () => {
      fs.mkdirSync(path.dirname(file));
      const config = JSON.parse(fs.readFileSync(path.join(repo, 'config/.defaultConfig.json'), 'utf8'));
      config.update.npm = 'false';
      config.custom = { retained: true };
      fs.writeFileSync(file, require('../config/store.ts').stringify(config));
      const before = fs.readFileSync(file);
      const receipt = fs.readFileSync(markerPath);
      const preload = path.join(root, 'fail-consent-input.cjs');
      const interrupted = ['130', '143'].includes(failure);
      fs.writeFileSync(preload, `
const fs = require('fs');
const helpers = require(${JSON.stringify(path.join(repo, 'commands/commandHelpers.ts'))});
const read = fs.readSync;
let consumed = 0;
fs.readSync = (fd, ...args) => {
  if (fd !== 0) return read.call(fs, fd, ...args);
  if (consumed >= ${prompt === 'backup' ? 0 : 2}) {
    ${interrupted ? `throw new helpers.CommandInterrupted(${failure});`
      : `throw Object.assign(new Error('PRIVATE_INPUT_FAILURE ghp_fixture_secret /private/example'), { code: ${JSON.stringify(failure)} });`}
  }
  const count = read.call(fs, fd, ...args);
  consumed += count;
  return count;
};
`);
      packageEnv.NODE_OPTIONS = `${packageEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim();
      const result = run('n\ny\n');
      const output = result.stdout + result.stderr;
      assert.equal(result.status, interrupted ? Number(failure) : 1, output);
      assert.include(result.stdout, 'Configure or review your GitHub backup?');
      if (prompt === 'preferences') assert.include(result.stdout, 'Review your Ballin preferences?');
      else assert.notInclude(result.stdout, 'Review your Ballin preferences?');
      for (const secret of ['PRIVATE_INPUT_FAILURE', 'ghp_fixture_secret', '/private/example']) assert.notInclude(output, secret);
      if (interrupted) {
        assert.include(output, 'Interrupted. Earlier completed changes remain.');
        assert.notInclude(result.stderr, 'Run `ballin');
      } else {
        assert.include(result.stderr, `stdin read: ${failure}`);
        assert.include(result.stderr, `Unable to read ${prompt === 'backup' ? 'backup setup' : 'preference review'} input.`);
        assert.include(result.stderr, prompt === 'backup' ? 'Run `ballin setup --initial`' : 'Run `ballin setup`');
      }
      assert.notInclude(output, 'Initial setup complete');
      assert.notInclude(output, 'Initial setup cancelled');
      assert.notInclude(output, 'Update global npm packages?');
      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(fs.readFileSync(markerPath), receipt);
      assert.isFalse(fs.existsSync(path.join(home, '.ballin/.analytics/install-id')));
      assertUntouched();
    });
  }
  it('creates external config on EOF without touching profiles, command links or Git state', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Initial setup cancelled');
    assert.include(result.stdout, `[[ -r '${repo}/completions/_ballin' ]] && source '${repo}/completions/_ballin'`);
    assert.include(result.stdout, `[[ -r '${repo}/completions/ballin.bash' ]] && source '${repo}/completions/ballin.bash'`);
    assert.isTrue(fs.existsSync(file));
    assertUntouched();
  });
  it('can decline both optional stages and repeat without losing choices or identity', () => {
    assert.equal(run('n\nn\n').status, 0);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.update.npm = 'false'; config.custom = { retained: true };
    fs.writeFileSync(file, JSON.stringify(config));
    const identity = path.join(home, '.ballin/.analytics/install-id');
    fs.mkdirSync(path.dirname(identity), { recursive: true });
    const before = 'da7a5eef-b9b0-4d8b-b9b5-7465e79d6f31';
    fs.writeFileSync(identity, before);
    const result = run('n\nn\n');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Initial setup complete');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.update.npm, 'false'); assert.deepEqual(after.custom, { retained: true });
    assert.equal(fs.readFileSync(identity, 'utf8'), before);
    assertUntouched();
  });
  it('onboards a stable release package through the same optional setup without changing ownership', () => {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    Object.assign(marker, { schema: 3,
      selection: { kind: 'release', value: `v${marker.version}`, releaseId: '123' },
      runtime: { nodeMajor: 26, minimumNode: '24.12.0' },
    });
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    const result = run('n\nn\n');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Initial setup complete');
    assert.isTrue(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), marker);
    assertUntouched();
  });
  it('retains preference cancellation and does not offer self-update for a package', () => {
    const result = run('n\ny\n');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Review cancelled');
    assert.include(result.stdout, 'Initial setup cancelled');
    assertUntouched();
  });
  it('completes preference review without running updates or backups', () => {
    const result = run('n\ny\n' + 'n\n'.repeat(8));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Initial setup complete');
    assert.include(result.stdout, 'Homebrew manages Ballin updates');
    assert.notInclude(result.stdout, 'Update Ballin?');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).analytics.enabled, 'false');
    assertUntouched();
  });
  it('stops safely when optional backup cannot authenticate, then allows retry', () => {
    const result = run('y\n\n');
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.include(fs.readFileSync(path.join(root, 'unexpected'), 'utf8'), 'gh');
    fs.unlinkSync(path.join(root, 'unexpected'));
    assert.isTrue(fs.existsSync(file));
    const retry = run('n\nn\n');
    assert.equal(retry.status, 0, retry.stderr + retry.stdout);
    assert.include(retry.stdout, 'Initial setup complete');
    assertUntouched();
  });
  it('cancels optional backup before authentication without entering preferences', () => {
    const result = run('y\n');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Backup setup cancelled');
    assert.include(result.stdout, 'Initial setup cancelled');
    assert.notInclude(result.stdout, 'Review your Ballin preferences?');
    assertUntouched();
  });
  it('validates an existing fixture backup and continues to preference consent', () => {
    assert.equal(run('n\nn\n').status, 0);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.backup = { repository: fixtureDestination, includeSensitive: 'false' };
    fs.writeFileSync(file, JSON.stringify(config));
    const statePath = path.join(root, 'repository.json');
    fs.writeFileSync(statePath, JSON.stringify(fixtureState()));
    installRepositoryFixture(tools, statePath);
    const result = run('y\nn\n');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'Review your Ballin preferences?');
    assert.include(result.stdout, 'Initial setup complete');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).backup.repository, fixtureDestination);
    assertUntouched();
  });
  it('reports a preference save failure without completing setup or losing saved config', () => {
    const preload = path.join(root, 'deny-preference-write.cjs');
    fs.writeFileSync(preload, `
const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = (from, to, ...args) => {
  if (to === ${JSON.stringify(path.join(fs.realpathSync(home), '.ballin/ballin.config.json'))}) throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' });
  return rename.call(fs, from, to, ...args);
};
`);
    packageEnv.NODE_OPTIONS = `${packageEnv.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim();
    const result = run('n\ny\ny\n');
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.include(result.stderr, 'Unable to complete preference review');
    assert.notInclude(result.stdout, 'Initial setup complete');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).update.npm, 'false');
    assertUntouched();
  });
  it('rejects shadowed package commands before creating configuration', () => {
    const shadow = path.join(root, 'shadow'); fs.mkdirSync(shadow);
    fs.writeFileSync(path.join(shadow, 'ballin'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const selectedTools = tools;
    tools = shadow + path.delimiter + selectedTools;
    const result = run('n\nn\n');
    tools = selectedTools;
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.include(result.stderr, 'takes precedence');
    assert.isFalse(fs.existsSync(file));
    assertUntouched();
  });
  it('requires current ownership metadata for initial onboarding', () => {
    fs.writeFileSync(markerPath, JSON.stringify({ manager: 'homebrew', schema: 1 }));
    const result = run();
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'legacy package metadata');
    assert.isFalse(fs.existsSync(file));
    assertUntouched();
  });
  it('rejects Git installs before creating configuration', () => {
    fs.unlinkSync(markerPath);
    const result = run('n\nn\n');
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'only for Homebrew installations');
    assert.isFalse(fs.existsSync(file));
    assertUntouched();
  });
  it('rejects malformed existing config without overwriting it', () => {
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{broken');
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assertUntouched();
  });
  it('keeps bare setup preference-only and exposes initial setup in help', () => {
    const help = run('', ['setup', '--help']);
    assert.equal(help.status, 0); assert.include(help.stdout, '--initial');
    const result = run('', ['setup']);
    assert.equal(result.status, 0); assert.include(result.stdout, 'Review cancelled');
    assert.notInclude(result.stdout, 'Configure or review your GitHub backup?');
    assertUntouched();
  });
  it('rejects extra initial-setup arguments before changing user state', () => {
    const result = run('', ['setup', '--initial', 'extra']);
    assert.equal(result.status, 2);
    assert.isFalse(fs.existsSync(file));
    assertUntouched();
  });
});
