const { zshStartupDirectory } = require('../commands/shell_location.ts');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('original-shell location evidence', () => {
  let home: string; let shell: string; let env: NodeJS.ProcessEnv;
  const evidence = () => ({ parent: (pid: number) => pid === 300 ? 200 : 100, executable: () => shell });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-shell-'));
    shell = path.join(home, 'zsh'); fs.writeFileSync(shell, 'fixture');
    env = { HOME: home, SHELL: shell, BALLIN_SHELL_PID: '100', BALLIN_SHELL_HOME: home,
      BALLIN_SHELL_CONFIGURED: shell, BALLIN_SHELL_ZDOTDIR_SET: '', BALLIN_SHELL_ZDOTDIR: '' };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  it('uses matching live ancestry and executable identity, including an unset ZDOTDIR and missing .zshrc', () => {
    assert.equal(zshStartupDirectory(env, evidence(), 300), home);
    env.BALLIN_SHELL_ZDOTDIR_SET = 'x'; env.BALLIN_SHELL_ZDOTDIR = path.join(home, 'custom');
    assert.equal(zshStartupDirectory(env, evidence(), 300), path.join(home, 'custom'));
    env.ZDOTDIR = '/later-change'; // A child environment is not the original shell snapshot.
    assert.equal(zshStartupDirectory(env, evidence(), 300), path.join(home, 'custom'));
  });
  it('falls back for missing, stale, malformed, mismatched and uncertain provenance', () => {
    for (const override of [{ BALLIN_SHELL_PID: undefined }, { BALLIN_SHELL_PID: 'bad' }, { BALLIN_SHELL_PID: '999' },
      { BALLIN_SHELL_PID: '300' }, { BALLIN_SHELL_HOME: '/other' }, { BALLIN_SHELL_CONFIGURED: '/bin/bash' },
      { BALLIN_SHELL_ZDOTDIR_SET: undefined }, { BALLIN_SHELL_ZDOTDIR_SET: 'x', BALLIN_SHELL_ZDOTDIR: '' },
      { BALLIN_SHELL_ZDOTDIR_SET: 'x', BALLIN_SHELL_ZDOTDIR: 'relative' }]) {
      assert.isNull(zshStartupDirectory({ ...env, ...override }, evidence(), 300));
    }
    assert.isNull(zshStartupDirectory(env, { ...evidence(), executable: () => '/bin/bash' }, 300));
    assert.isNull(zshStartupDirectory(env, { ...evidence(), parent: () => null }, 300));
    assert.isNull(zshStartupDirectory(env, { ...evidence(), executable: () => null }, 300));
  });
  it('does not read or run startup files and accepts same-file configured-shell aliases', () => {
    fs.writeFileSync(path.join(home, '.zshenv'), 'throw unsafe startup content');
    const alias = path.join(home, 'alias'); fs.mkdirSync(alias); fs.symlinkSync(shell, path.join(alias, 'zsh'));
    assert.equal(zshStartupDirectory(env, { ...evidence(), executable: () => path.join(alias, 'zsh') }, 300), home);
    assert.isNull(zshStartupDirectory(env, { ...evidence(), parent: () => 300 }, 300));
  });
  (process.platform === 'darwin' ? it : it.skip)('checks real Mac shell identity with unexported ZDOTDIR before Bash', function() {
    this.timeout(10000);
    const script = `ZDOTDIR="$HOME/custom"
      BALLIN_SHELL_PID=$$ BALLIN_SHELL_HOME="$HOME" BALLIN_SHELL_CONFIGURED="$SHELL" BALLIN_SHELL_ZDOTDIR_SET="\${ZDOTDIR+x}" BALLIN_SHELL_ZDOTDIR="\${ZDOTDIR-}" /bin/bash -c 'exec "$RUNTIME" "$LOCATION"'
      :`;
    const result = spawnSync('/bin/zsh', ['-f', '-c', script], { encoding: 'utf8', env: testChildEnvironment({
      HOME: home, SHELL: '/bin/zsh', RUNTIME: process.execPath, LOCATION: path.resolve(__dirname, '../commands/shell_location.ts'),
    }) });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, home + '/custom');
    const mismatch = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: testChildEnvironment({
      HOME: home, SHELL: '/bin/zsh', RUNTIME: process.execPath, LOCATION: path.resolve(__dirname, '../commands/shell_location.ts'),
    }) });
    assert.equal(mismatch.status, 0); assert.equal(mismatch.stdout, '');
  });
  for (const outcome of ['matching', 'unavailable', 'timeout', 'SIGINT', 'status143']) {
    it(`handles native process lookup ${outcome} without startup execution or signal-to-fallback conversion`, () => {
      const preload = path.join(home, 'native-fixture.cjs');
      fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', {value:'darwin'});
        require('child_process').spawnSync=(command,args)=> {
          if(command==='/bin/ps') return {status:0,signal:null,stdout:'100\\n'};
          if(command!=='/usr/bin/osascript' || !args.includes('JavaScript')) throw Error('Unexpected lookup');
          return ${JSON.stringify(outcome === 'matching' ? { status: 0, signal: null, stdout: shell + '\n' }
            : outcome === 'SIGINT' ? { status: null, signal: 'SIGINT', stdout: '' }
            : outcome === 'status143' ? { status: 143, signal: null, stdout: '' }
            : outcome === 'timeout' ? { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '' }
            : { status: 1, signal: null, stdout: '' })};
        };`);
      const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../commands/shell_location.ts')], {
        encoding: 'utf8', env: testChildEnvironment(env),
      });
      assert.equal(result.status, outcome === 'SIGINT' ? 130 : outcome === 'status143' ? 143 : 0, result.stderr);
      assert.equal(result.stdout, outcome === 'matching' ? home : '');
    });
  }
});
