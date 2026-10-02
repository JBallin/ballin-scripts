const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { terminalEmphasis } = require('../commands/terminalStyle.ts');

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('terminal emphasis', () => {
  it('uses only owned bold and underline attributes on supported terminals', () => {
    assert.equal(terminalEmphasis('stage', 'bold', { isTTY: true }, {}), '\x1b[1mstage\x1b[0m');
    assert.equal(terminalEmphasis('key', 'underline', { isTTY: true }, { NO_COLOR: '' }), '\x1b[4mkey\x1b[0m');
  });

  for (const fixture of [
    { stream: {}, env: { FORCE_COLOR: '1' } },
    { stream: { isTTY: false }, env: {} },
    { stream: { isTTY: true }, env: { TERM: 'dumb', FORCE_COLOR: '1' } },
    { stream: { isTTY: true }, env: { NO_COLOR: '0', FORCE_COLOR: '1' } },
    { stream: { isTTY: true }, env: { NO_COLOR: '1' } },
  ]) {
    it(`keeps output plain for ${JSON.stringify(fixture)}`, () => {
      assert.equal(terminalEmphasis('stage', 'bold', fixture.stream, fixture.env), 'stage');
    });
  }

  it('preserves help, stage and config bytes across simulated terminal modes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-emphasis-'));
    const preload = path.join(directory, 'tty.cjs');
    const config = path.join(directory, 'ballin.config.json');
    fs.writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });');
    fs.writeFileSync(config, JSON.stringify({ backup: { repository: null }, analytics: { enabled: 'false' } }));
    const run = (args: string[], env: NodeJS.ProcessEnv = {}, stage = false) => spawnSync(process.execPath,
      stage ? ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'commandHelpers.ts'))}).progress('Updating Homebrew')`]
        : [path.join(__dirname, '..', 'bin', 'ballin'), ...args], {
        encoding: 'utf8',
        env: testChildEnvironment({ HOME: directory, BALLIN_TEST_CONFIG_PATH: config, ...env }),
      });
    try {
      const plainHelp = run(['--help']);
      assert.equal(plainHelp.status, 0, plainHelp.stderr);
      assert.equal(stripAnsi(plainHelp.stdout), plainHelp.stdout);
      assert.include(plainHelp.stdout, 'Run `ballin <command> --help` for command-specific help.');
      for (const env of [
        { NODE_OPTIONS: `--require ${preload}`, TERM: 'xterm' },
        { NODE_OPTIONS: `--require ${preload}`, TERM: 'dumb' },
        { NODE_OPTIONS: `--require ${preload}`, NO_COLOR: '1', FORCE_COLOR: '1' },
        { FORCE_COLOR: '1' },
      ]) {
        const help = run(['--help'], env);
        assert.equal(help.status, 0, help.stderr);
        assert.equal(stripAnsi(help.stdout), plainHelp.stdout);
        const styled = env.TERM === 'xterm';
        assert.equal(help.stdout.includes('\x1b['), styled);
        const stage = run([], env, true);
        assert.equal(stage.status, 0, stage.stderr);
        assert.equal(stripAnsi(stage.stdout), '\n==> Updating Homebrew\n');
        assert.equal(stage.stdout.includes('\x1b['), styled);
        const value = run(['config', 'get', 'backup.repository'], env);
        assert.equal(value.status, 0, value.stderr);
        assert.equal(value.stdout, 'null\n');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
