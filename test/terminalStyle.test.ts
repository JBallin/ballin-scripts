const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { terminalPath, terminalEmphasis, terminalHeading, terminalCommand, terminalCommandReferences } = require('../commands/terminalStyle.ts');

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('terminal emphasis', () => {
  it('abbreviates only paths contained within HOME', () => {
    const home = '/tmp/ballin-home';
    assert.equal(terminalPath(home, home), '~');
    assert.equal(terminalPath(home + '/.ballin-scripts/ballin.config.json', home), '~/.ballin-scripts/ballin.config.json');
    assert.equal(terminalPath(home + '-sibling/file', home), home + '-sibling/file');
    assert.equal(terminalPath(home + '/../outside', home), '/tmp/outside');
    assert.equal(terminalPath('/usr/local/bin', home), '/usr/local/bin');
    assert.equal(terminalPath('/usr/local/bin', ''), '/usr/local/bin');
  });
  it('uses only owned bold and underline attributes on supported terminals', () => {
    assert.equal(terminalHeading('Checking tools', { isTTY: true }, {}), '\x1b[34m==>\x1b[1;39m Checking tools\x1b[0m');
    assert.equal(terminalEmphasis('stage', 'bold', { isTTY: true }, {}), '\x1b[1mstage\x1b[0m');
    assert.equal(terminalEmphasis('key', 'underline', { isTTY: true }, { NO_COLOR: '' }), '\x1b[4mkey\x1b[0m');
    assert.equal(terminalCommand('ballin help', { isTTY: true }, {}), '\x1b[1mballin help\x1b[0m');
    assert.equal(terminalCommand('ballin help', { isTTY: true }, { NO_COLOR: '' }), '\x1b[1mballin help\x1b[0m');
  });

  it('formats only explicitly selected command references, leaving identifiers and shorthand intact', () => {
    const prose = 'Run `ballin backup` twice: `ballin backup`. Keep `update.backup`, `true`, `backup`, and `ballin config get/set/reset`.';
    assert.equal(terminalCommandReferences(prose, ['ballin backup'], { isTTY: true }, {}),
      'Run \x1b[1mballin backup\x1b[0m twice: \x1b[1mballin backup\x1b[0m. Keep `update.backup`, `true`, `backup`, and `ballin config get/set/reset`.');
    assert.equal(terminalCommandReferences('Unselected `ballin doctor`.', [], { isTTY: true }, {}), 'Unselected `ballin doctor`.');
    assert.equal(terminalCommandReferences('Run `echo $&`.', ['echo $&'], { isTTY: true }, {}), 'Run \x1b[1mecho $&\x1b[0m.');
  });

  for (const fixture of [
    { stream: {}, env: { FORCE_COLOR: '1' } },
    { stream: { isTTY: false }, env: {} },
    { stream: { isTTY: true }, env: { TERM: 'dumb', FORCE_COLOR: '1' } },
    { stream: { isTTY: true }, env: { NO_COLOR: '0', FORCE_COLOR: '1' } },
    { stream: { isTTY: true }, env: { NO_COLOR: '1' } },
  ]) {
    it(`keeps output plain for ${JSON.stringify(fixture)}`, () => {
      assert.equal(terminalHeading('Checking tools', fixture.stream, fixture.env), '==> Checking tools');
      assert.equal(terminalEmphasis('stage', 'bold', fixture.stream, fixture.env), 'stage');
      assert.equal(terminalCommand('ballin help', fixture.stream, fixture.env), '`ballin help`');
      assert.equal(terminalCommandReferences('Run `ballin help`.', ['ballin help'], fixture.stream, fixture.env), 'Run `ballin help`.');
    });
  }

  describe('simulated terminal modes', () => {
    let directory: string;
    let preload: string;
    let config: string;
    const run = (args: string[], env: NodeJS.ProcessEnv = {}, stage = false) => spawnSync(process.execPath,
      stage ? ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'commandHelpers.ts'))}).progress('Updating Homebrew')`]
        : [path.join(__dirname, '..', 'bin', 'ballin'), ...args], {
        encoding: 'utf8',
        env: testChildEnvironment({ HOME: directory, BALLIN_TEST_CONFIG_PATH: config, ...env }),
      });
    let plainHelp: ReturnType<typeof run>;

    before(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-emphasis-'));
      preload = path.join(directory, 'tty.cjs');
      config = path.join(directory, 'ballin.config.json');
      fs.writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });');
      fs.writeFileSync(config, JSON.stringify({ backup: { repository: null }, analytics: { enabled: 'false' } }));
      plainHelp = run(['--help']);
      assert.equal(plainHelp.status, 0, plainHelp.stderr);
      assert.equal(stripAnsi(plainHelp.stdout), plainHelp.stdout);
      assert.include(plainHelp.stdout, 'Run `ballin help <command...>` for command or subcommand help.');
    });

    after(() => {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    });

    for (const mode of [
      { name: 'a supported TTY', tty: true, env: { TERM: 'xterm' } },
      { name: 'a dumb terminal', tty: true, env: { TERM: 'dumb' } },
      { name: 'NO_COLOR with FORCE_COLOR', tty: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' } },
      { name: 'redirected output with FORCE_COLOR', tty: false, env: { FORCE_COLOR: '1' } },
    ]) {
      it(`preserves help, stage and config bytes for ${mode.name}`, () => {
        const env = { ...(mode.tty ? { NODE_OPTIONS: `--require ${preload}` } : {}), ...mode.env };
        const help = run(['--help'], env);
        assert.equal(help.status, 0, help.stderr);
        const styled = env.TERM === 'xterm';
        assert.equal(stripAnsi(help.stdout), styled
          ? plainHelp.stdout.replace('`ballin help <command...>`', 'ballin help <command...>') : plainHelp.stdout);
        if (styled) assert.include(help.stdout, 'Run \x1b[1mballin help <command...>\x1b[0m for command or subcommand help.');
        assert.equal(help.stdout.includes('\x1b['), styled);
        const stage = run([], env, true);
        assert.equal(stage.status, 0, stage.stderr);
        assert.equal(stripAnsi(stage.stdout), '\n==> Updating Homebrew\n');
        assert.equal(stage.stdout.includes('\x1b['), styled);
        if (styled) assert.equal(stage.stdout, '\n\x1b[34m==>\x1b[1;39m Updating Homebrew\x1b[0m\n');
        const value = run(['config', 'get', 'backup.repository'], env);
        assert.equal(value.status, 0, value.stderr);
        assert.equal(value.stdout, 'null\n');
      });
    }
  });
});
