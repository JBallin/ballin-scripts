const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createPackageSourceFixture } = require('./helpers/package_source.ts');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');

describe('package runtime source modules', () => {
  const source = path.join(__dirname, '..');
  let root: string;
  let home: string;
  let tools: string;
  let file: string;
  let fixture: ReturnType<typeof createPackageSourceFixture>;
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [path.join(source, 'bin/ballin'), ...args], {
    input: '', encoding: 'utf8', timeout: 15000,
    env: { HOME: home, PATH: tools, NO_COLOR: '1', TERM: 'dumb', BALLIN_NO_ANALYTICS: '1', ...fixture.env, ...env },
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-package-runtime-'));
    home = path.join(root, 'home'); tools = path.join(root, 'tools');
    fs.mkdirSync(path.join(home, '.ballin'), { recursive: true });
    fs.mkdirSync(tools);
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    fs.symlinkSync(path.join(source, 'bin/ballin'), path.join(tools, 'ballin'));
    fixture = createPackageSourceFixture(root, source);
    fs.writeFileSync(fixture.markerPath, JSON.stringify({
      manager: 'homebrew', schema: 2, formula: 'owner/tap/ballin-experiment', version: require('../package.json').version,
      sourceRevision: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), selection: { kind: 'development' },
      commandPath: path.join(source, 'bin/ballin'), completionRoot: path.join(source, 'completions'),
    }));
    file = path.join(home, '.ballin/ballin.config.json');
    fs.writeFileSync(file, JSON.stringify({
      update: { cleanup: true, nvm: false, npm: false, softwareupdate: false, selfUpdate: true, backup: false },
      backup: { repository: null, includeSensitive: 'false' }, analytics: { enabled: 'false' },
    }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('routes lifecycle commands to the recorded formula without touching Git or package code', () => {
    const legacy = path.join(home, '.ballin-scripts');
    fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep'), 'preserved');
    const config = fs.readFileSync(file, 'utf8');
    for (const [command, brewCommand] of [['self-update', 'upgrade'], ['uninstall', 'uninstall']]) {
      const result = run([command]);
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, `brew ${brewCommand} owner/tap/ballin-experiment`);
      assert.equal(fs.readFileSync(path.join(legacy, 'keep'), 'utf8'), 'preserved');
      assert.equal(fs.readFileSync(file, 'utf8'), config);
      assert.isTrue(fs.existsSync(path.join(source, 'bin/ballin')));
    }
  });
  it('reports verified package ownership and development provenance in doctor', () => {
    const result = run(['doctor', '--verbose']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.include(result.stdout, 'PATH selects the Homebrew-owned Ballin command');
    assert.include(result.stdout, 'Development package');
    assert.include(result.stdout, 'This does not establish a published release');
  });
  for (const [upgradeStatus, cleanupStatus, failVersionCapture] of [[0, 0, false], [7, 0, false], [0, 9, false], [0, 0, true]] as const) {
    it(`defers package cleanup and preserves the final result (upgrade=${upgradeStatus}, cleanup=${cleanupStatus}, versionError=${failVersionCapture})`, () => {
      const log = path.join(root, 'brew.log');
      fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/sh
printf '%s\\n' "$1" >> "$BREW_LOG"
[ "$HOMEBREW_NO_INSTALL_CLEANUP" = 1 ] || exit 41
case "$1" in
  upgrade) exit ${upgradeStatus} ;;
  cleanup) /bin/rm -f "$PACKAGE_MARKER"; exit ${cleanupStatus} ;;
esac
`, { mode: 0o755 });
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.analytics.enabled = 'true';
      fs.writeFileSync(file, JSON.stringify(config));
      const capture = createAnalyticsCapture(root, source);
      if (failVersionCapture) fs.appendFileSync(capture.preloadPath,
        `require(${JSON.stringify(path.join(source, 'commands/analytics.ts'))}).loadAppVersion = () => { throw new Error('fixture version failure'); };`);
      const result = run(['update'], {
        ...capture.env, NODE_OPTIONS: `${fixture.env.NODE_OPTIONS} ${capture.env.NODE_OPTIONS}`,
        BREW_LOG: log, PACKAGE_MARKER: fixture.markerPath,
      });
      assert.equal(result.status, upgradeStatus || cleanupStatus, result.stderr + result.stdout);
      assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
        upgradeStatus ? ['update', 'upgrade', 'doctor'] : ['update', 'upgrade', 'doctor', 'cleanup']);
      assert.equal(fs.existsSync(fixture.markerPath), Boolean(upgradeStatus));
      assert.isTrue(fs.existsSync(path.join(source, 'bin/ballin')), 'the fixture never removes source code');
      const events = capture.readEvents();
      assert.lengthOf(events, 1);
      assert.deepInclude(events[0], {
        command: 'ballin update', status: upgradeStatus || cleanupStatus ? 'failure' : 'success',
        appVersion: failVersionCapture ? 'unknown' : 'development',
      });
    });
  }
});
