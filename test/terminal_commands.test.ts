const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { createSandbox, cleanupSandbox } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
import type { Sandbox } from './helpers/onboarding.ts';

describe('command references at prose output boundaries', () => {
  let root: string;
  let config: string;
  let preload: string;
  const run = (args: string[], stdout: boolean, stderr: boolean, overrides: NodeJS.ProcessEnv = {}) => {
    fs.writeFileSync(preload, `Object.defineProperty(process.stdout, 'isTTY', {value:${stdout}}); Object.defineProperty(process.stderr, 'isTTY', {value:${stderr}});`);
    return spawnSync(process.execPath, [path.join(__dirname, '../bin/ballin'), ...args], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: root, BALLIN_TEST_CONFIG_PATH: config,
        NODE_OPTIONS: `--require=${preload}`, TERM: 'xterm', ...overrides }),
    });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-command-prose-'));
    config = path.join(root, 'ballin.config.json');
    preload = path.join(root, 'tty.cjs');
    fs.writeFileSync(config, JSON.stringify({ analytics: { enabled: 'false' }, backup: { repository: null }, literal: '`ballin setup`\u001b[31m\n\n' }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const mode of [
    { name: 'capable TTY', stdout: true, stderr: true, env: {}, styled: true },
    { name: 'redirected output', stdout: false, stderr: false, env: { FORCE_COLOR: '1' }, styled: false },
    { name: 'dumb terminal', stdout: true, stderr: true, env: { TERM: 'dumb', FORCE_COLOR: '1' }, styled: false },
    { name: 'nonempty NO_COLOR', stdout: true, stderr: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' }, styled: false },
    { name: 'NO_COLOR zero', stdout: true, stderr: true, env: { NO_COLOR: '0' }, styled: false },
    { name: 'empty NO_COLOR', stdout: true, stderr: true, env: { NO_COLOR: '' }, styled: true },
  ]) {
    it(`preserves help roles, recovery and config bytes on ${mode.name}`, () => {
      const command = (text: string) => mode.styled ? `\x1b[1m${text}\x1b[0m` : `\`${text}\``;
      const cli = (args: string[]) => run(args, mode.stdout, mode.stderr, mode.env);
      const help = cli(['update', '--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.include(help.stdout, `Use ${command('ballin config get update')} to inspect settings.`);
      assert.include(help.stdout, '    ballin update\n');
      const backup = cli(['backup', '--help']);
      assert.equal(backup.status, 0, backup.stderr);
      assert.include(backup.stdout, '`setup` creates or reconnects');
      assert.include(backup.stdout, `review them with ${command('ballin setup')}.`);
      assert.include(backup.stdout, `Run ${command('ballin backup <subcommand> --help')} for subcommand-specific help.`);
      const backupAlias = cli(['help', 'backup']);
      assert.equal(backupAlias.status, 0, backupAlias.stderr);
      assert.equal(backupAlias.stdout, backup.stdout);
      const shorthand = cli(['setup', '--help']);
      assert.equal(shorthand.status, 0, shorthand.stderr);
      assert.include(shorthand.stdout, 'Use `ballin config get/set/reset` for direct configuration.');
      const configHelp = cli(['config', '--help']);
      assert.include(configHelp.stdout, '`update.cleanup`');
      assert.notInclude(configHelp.stdout, '\x1b');
      const value = cli(['config', 'get', 'literal']);
      assert.equal(value.status, 0, value.stderr);
      assert.equal(value.stdout, '`ballin setup`\x1b[31m\n\n\n');
      const before = fs.readFileSync(config);
      const error = cli(['config', 'get', 'missing']);
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.include(error.stderr, `Use ${command('ballin config get')} to inspect available keys.`);
      assert.deepEqual(fs.readFileSync(config), before);
      fs.writeFileSync(config, '{invalid');
      const recovery = cli(['setup']);
      assert.equal(recovery.status, 1);
      assert.equal(recovery.stdout, '');
      assert.include(recovery.stderr, `Use ${command('ballin config get')} to inspect it or ${command('ballin config reset')} to restore defaults.`);
      assert.equal(fs.readFileSync(config, 'utf8'), '{invalid');
    });
  }

  for (const stdout of [false, true]) {
    it(`uses each destination independently when stdout is ${stdout ? 'TTY' : 'redirected'}`, () => {
      const help = run(['--help'], stdout, !stdout);
      assert.equal(help.status, 0, help.stderr);
      assert.include(help.stdout, stdout
        ? 'Run \x1b[1mballin <command> --help\x1b[0m for command-specific help.'
        : 'Run `ballin <command> --help` for command-specific help.');
      const unknown = run(['unknown-command'], stdout, !stdout);
      assert.equal(unknown.status, 2);
      assert.equal(unknown.stderr, stdout
        ? 'Unknown Ballin command: unknown-command\nTry: `ballin --help`\n'
        : 'Unknown Ballin command: unknown-command\nTry: \x1b[1mballin --help\x1b[0m\n');
      const configError = run(['config', 'get', 'missing'], stdout, !stdout);
      assert.include(configError.stderr, stdout ? '`ballin config get`' : '\x1b[1mballin config get\x1b[0m');
    });
  }

  it('styles doctor recovery and repository diagnostics without altering their stored inputs', () => {
    const report = { status: 'fail', checks: [
      { id: 'backup.config', label: 'Backup', status: 'fail', summary: 'Run `ballin backup setup`. Keep `backup.includeSensitive`.' },
    ] };
    fs.writeFileSync(preload, "Object.defineProperty(process.stdout, 'isTTY', {value:true});");
    const script = `
      const assert = require('assert/strict');
      const report = ${JSON.stringify(report)};
      const before = JSON.stringify(report);
      const {formatDefaultDoctorReport} = require(${JSON.stringify(path.join(__dirname, '../commands/doctor_report.ts'))});
      const {repositoryMessages, formatRepositoryMessage} = require(${JSON.stringify(path.join(__dirname, '../commands/backup_repository.ts'))});
      process.stdout.write(formatDefaultDoctorReport(report));
      process.stdout.write(formatRepositoryMessage('authentication'));
      process.stdout.write(formatRepositoryMessage('prerequisite'));
      process.stdout.write(formatRepositoryMessage('resource-limit'));
      assert.equal(JSON.stringify(report), before);
      assert.equal(repositoryMessages.authentication.includes('\x1b'), false);
      assert.equal(formatRepositoryMessage('invalid-problem'), undefined);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8',
      env: testChildEnvironment({ NODE_OPTIONS: `--require=${preload}`, TERM: 'xterm' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Run \x1b[1mballin backup setup\x1b[0m. Keep `backup.includeSensitive`.');
    assert.include(result.stdout, 'Run \x1b[1mballin backup disconnect\x1b[0m, then \x1b[1mballin backup setup\x1b[0m');
    assert.include(result.stdout, 'Run \x1b[1mgh auth login --hostname github.com\x1b[0m');
    assert.include(result.stdout, 'rerun \x1b[1mballin backup setup\x1b[0m.');
    assert.include(result.stdout, 'Use \x1b[1mballin backup open\x1b[0m,');
  });
});

describe('bootstrap command references on a real PTY without running an installer', function() {
  this.timeout(30000);
  let sandbox: Sandbox;
  afterEach(() => { if (sandbox) cleanupSandbox(sandbox.root); });
  for (const file of ['install.sh', 'quickstart.sh']) {
    it(`renders ${file} completion and stderr references with all fallback gates`, () => {
      sandbox = createSandbox();
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const helper = source.match(/^command_reference\(\) \{\n[\s\S]*?^\}/mu)?.[0];
      const completion = source.match(/^[ \t]*printf '\\n😎 Setup complete![^\n]*\n[ \t]*command_reference 'ballin help'\n[ \t]*printf '\.\\n'/mu)?.[0];
      assert.isString(helper); assert.isString(completion);
      // Execute only the extracted pure formatter and print statements. No source,
      // eval of the bootstrap, installer entry, platform discovery or setup runs.
      const plain = '`ballin help`';
      const bold = '\x1b[1mballin help\x1b[0m';
      const program = `${helper}\nexport TERM=xterm NO_COLOR=''\n${completion}
        printf '\\nPIPE:'; command_reference 'ballin help' > '${sandbox.scratch}/reference'; /bin/cat '${sandbox.scratch}/reference'
        printf '\\nSTDERR:'; { command_reference 'ballin help' 2 >&2; } > '${sandbox.scratch}/other'
        export TERM=dumb FORCE_COLOR=1; printf '\\nDUMB:'; command_reference 'ballin help'
        export TERM=xterm NO_COLOR=0; printf '\\nZERO:'; command_reference 'ballin help'
        export NO_COLOR=1; printf '\\nNO_COLOR:'; command_reference 'ballin help'
        export NO_COLOR=''; printf '\\nEMPTY:'; command_reference 'ballin help'; printf '\\n'
      `;
      const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', program], []);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      assert.include(output, `😎 Setup complete! Open a new Terminal and run ${bold}.\n`);
      for (const label of ['PIPE', 'DUMB', 'ZERO', 'NO_COLOR']) assert.include(output, `${label}:${plain}`);
      for (const label of ['STDERR', 'EMPTY']) assert.include(output, `${label}:${bold}`);
      assert.notInclude(output, '`\x1b[1m');
    });
  }
});
