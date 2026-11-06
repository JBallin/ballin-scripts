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
    const command = (text: string) => mode.styled ? `\x1b[1m${text}\x1b[0m` : `\`${text}\``;
    const cli = (args: string[]) => run(args, mode.stdout, mode.stderr, mode.env);
    // Independent command checks get separate budgets; compare aliases together.
    it(`preserves update help roles on ${mode.name}`, () => {
      const help = cli(['update', '--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.include(help.stdout.replace(/\s+/gu, ' '), `Use ${command('ballin config get update')} to inspect settings.`);
      assert.include(help.stdout, mode.styled ? '\x1b[1mUsage:\x1b[0m \x1b[1mballin update\x1b[0m\n' : 'Usage: ballin update\n');
    });
    it(`preserves backup help roles and alias output on ${mode.name}`, () => {
      const backup = cli(['backup', '--help']);
      assert.equal(backup.status, 0, backup.stderr);
      assert.include(backup.stdout.replace(/\x1b\[[0-9;]*m/gu, '').replace(/\s+/gu, ' '), 'setup create, reconnect to, or validate a backup');
      assert.deepEqual(backup.stdout.replace(/\x1b\[[0-9;]*m/gu, '').split('\n').slice(0, 2), ['Usage: ballin backup', '       ballin backup <command>']);
      assert.include(backup.stdout.replace(/\s+/gu, ' '), `review them with ${command('ballin backup setup')}.`);
      assert.include(backup.stdout.replace(/\s+/gu, ' '), `Run ${command('ballin help backup <subcommand>')} for subcommand-specific help.`);
      const backupAlias = cli(['help', 'backup']);
      assert.equal(backupAlias.status, 0, backupAlias.stderr);
      assert.equal(backupAlias.stdout, backup.stdout);
    });
    it(`preserves setup help notation on ${mode.name}`, () => {
      const shorthand = cli(['setup', '--help']);
      assert.equal(shorthand.status, 0, shorthand.stderr);
      assert.include(shorthand.stdout.replace(/\s+/gu, ' '), 'Use `ballin config get/set/reset` for direct configuration.');
    });
    it(`preserves config help notation on ${mode.name}`, () => {
      const configHelp = cli(['config', '--help']);
      assert.include(configHelp.stdout, '`update.cleanup`');
      assert.equal(configHelp.stdout.includes('\x1b'), mode.styled);
      assert.include(configHelp.stdout, mode.styled ? '\x1b[1mUsage:\x1b[0m \x1b[1mballin config [get [key]]\x1b[0m\n' : 'Usage: ballin config [get [key]]\n');
    });
    it(`preserves literal config bytes on ${mode.name}`, () => {
      const value = cli(['config', 'get', 'literal']);
      assert.equal(value.status, 0, value.stderr);
      assert.equal(value.stdout, '`ballin setup`\x1b[31m\n\n\n');
    });
    it(`styles missing-key recovery without changing config on ${mode.name}`, () => {
      const before = fs.readFileSync(config);
      const error = cli(['config', 'get', 'missing']);
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.include(error.stderr, `Use ${command('ballin config get')} to inspect available keys.`);
      assert.deepEqual(fs.readFileSync(config), before);
    });
    it(`styles malformed-config recovery without changing config on ${mode.name}`, () => {
      fs.writeFileSync(config, '{invalid');
      const recovery = cli(['setup']);
      assert.equal(recovery.status, 1);
      assert.equal(recovery.stdout, '');
      const icon = mode.styled ? '\x1b[0;31m✗\x1b[0m' : '✗';
      assert.isTrue(recovery.stderr.startsWith(`\n${icon} Unable to read or validate local preferences.\nConfig is not valid JSON.\n`));
      assert.include(recovery.stderr.replace(/\s+/gu, ' '), `Repair the file, or run ${command('ballin config reset')} to replace it with defaults, then run ${command('ballin setup')} again.`);
      assert.notInclude(recovery.stderr, '\n\n', 'the final error and recovery stay consecutive');
      // Keep the resolved path complete and copyable, even when the platform's
      // temporary directory is longer than the prose wrapping width.
      const diagnostic = `Configuration file: ${JSON.stringify(path.resolve(config))}`;
      assert.include(recovery.stderr.split('\n'), diagnostic);
      for (const line of recovery.stderr.trim().split('\n').filter((line: string) => line !== diagnostic)) {
        assert.isAtMost(require('../commands/terminalStyle.ts').visibleWidth(line), 80);
      }
      assert.equal(fs.readFileSync(config, 'utf8'), '{invalid');
    });
  }

  for (const stdout of [false, true]) {
    it(`uses each destination independently when stdout is ${stdout ? 'TTY' : 'redirected'}`, () => {
      const help = run(['--help'], stdout, !stdout);
      assert.equal(help.status, 0, help.stderr);
      assert.include(help.stdout, stdout
        ? '\x1b[1mballin help [command...]\x1b[0m'
        : 'ballin help [command...]');
      const unknown = run(['unknown-command'], stdout, !stdout);
      assert.equal(unknown.status, 2);
      assert.equal(unknown.stderr, stdout
        ? 'Unknown Ballin command: unknown-command\nTry: `ballin help`\n'
        : 'Unknown Ballin command: unknown-command\nTry: \x1b[1mballin help\x1b[0m\n');
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
      const marker = source.match(/^status_marker\(\) \{\n[\s\S]*?^\}/mu)?.[0];
      const complete = source.match(/^setup_complete\(\) \{\n[\s\S]*?^\}/mu)?.[0];
      const completion = source.match(/^[ \t]*printf '\\n'; setup_complete; printf '\\nOpen a new Terminal and run '\n[ \t]*command_reference 'ballin help'\n[ \t]*printf '\.\\n'/mu)?.[0];
      assert.isString(helper); assert.isString(marker); assert.isString(complete); assert.isString(completion);
      // Execute only the extracted pure formatter and print statements. No source,
      // eval of the bootstrap, installer entry, platform discovery or setup runs.
      const plain = '`ballin help`';
      const bold = '\x1b[1mballin help\x1b[0m';
      const program = `${helper}\n${marker}\n${complete}\nexport TERM=xterm NO_COLOR=''\n${completion}
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
      assert.include(output, `\x1b[0;32m✓\x1b[0m Setup complete.\nOpen a new Terminal and run ${bold}.\n`);
      for (const label of ['PIPE', 'DUMB', 'ZERO', 'NO_COLOR']) assert.include(output, `${label}:${plain}`);
      for (const label of ['STDERR', 'EMPTY']) assert.include(output, `${label}:${bold}`);
      assert.notInclude(output, '`\x1b[1m');
    });
  }
  it('styles actual installer retry output for its receiving stream', () => {
    sandbox = createSandbox();
    const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    const command = source.match(/^command_reference\(\) \{\n[\s\S]*?^\}/mu)?.[0];
    const retry = source.match(/^print_retry_guidance\(\) \{\n[\s\S]*?^\}/mu)?.[0];
    const prerequisite = source.match(/^    printf '\\nUpdate or activate Node\.js[^\n]+$/mu)?.[0];
    const preflight = source.match(/"\$\(print_retry_guidance 2\)"/u)?.[0];
    for (const fragment of [command, retry, prerequisite, preflight]) assert.isString(fragment);
    // Execute the actual output fragments only, never the installer or tools.
    const render = `${prerequisite}\nprintf 'ARG:%s\\n' ${preflight} >&2`;
    const program = `${command}\n${retry}
      export TERM=xterm NO_COLOR=''
      ballin_sha=fixture; ballin_mode=self-update; setup_mode=self-update
      { ${render}; } > '${sandbox.scratch}/out'
      printf 'OUT-PIPE:'; /bin/cat '${sandbox.scratch}/out'
      { ${render}; } 2> '${sandbox.scratch}/err'
      printf 'ERR-PIPE:'; /bin/cat '${sandbox.scratch}/err'
      ballin_mode=install; setup_mode=refresh
      printf 'EXISTING:'; print_retry_guidance; printf '\\n'
      setup_mode=fresh
      printf 'FRESH:'; print_retry_guidance; printf '\\n'
      printf 'FRESH-PREREQUISITE:'; print_retry_guidance 1 'rerun this installer'; printf '\\n'
      ballin_mode=self-update
      export NO_COLOR=0
      printf 'NO-COLOR:'; print_retry_guidance; printf '\\n'
      export NO_COLOR='' TERM=dumb FORCE_COLOR=1
      printf 'DUMB:'; print_retry_guidance; printf '\\n'
    `;
    const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', program], []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout.replace(/\r\n/gu, '\n');
    const plain = '`ballin self-update`';
    const bold = '\x1b[1mballin self-update\x1b[0m';
    const prefix = 'Update or activate Node.js using your existing installation method, then run ';
    assert.include(output, `${prefix}${plain} again.\n`);
    assert.include(output, `${prefix}${bold} again.\n`);
    assert.include(output, `ARG:run ${bold} again\n`);
    assert.include(output, `ARG:run ${plain} again\n`);
    assert.include(output, `EXISTING:use ${bold} for the default selection\n`);
    assert.include(output, 'FRESH:run this installer again\n');
    assert.include(output, 'FRESH-PREREQUISITE:rerun this installer\n');
    for (const gate of ['NO-COLOR', 'DUMB']) assert.include(output, `${gate}:run ${plain} again\n`);
    assert.notInclude(output, '`\x1b[1m');
  });

  it('styles trusted self-update refresh recovery for its receiving stream', () => {
    sandbox = createSandbox();
    const source = fs.readFileSync(path.join(__dirname, '../commands/repo_update.ts'), 'utf8');
    const command = source.match(/^const stderrCommand = [\s\S]*?^  \?[^\n]+;/mu)?.[0];
    const incomplete = source.match(/^  const incomplete = \(status: number\): void => \{[\s\S]*?^  \};/mu)?.[0];
    assert.isString(command); assert.isString(incomplete);
    // Only these actual pure output fragments run, with their two parameter
    // annotations removed. No updater import, Git, installer or setup executes.
    const renderer = path.join(sandbox.scratch, 'refresh-output.cjs');
    fs.writeFileSync(renderer, `${command.replace('(command: string): string', '(command)')}\nconst selection = { sha: 'fixture' };\n${incomplete.replace('(status: number): void', '(status)')}\nincomplete(0);\n`);
    const program = `
      export TERM=xterm NO_COLOR=''
      printf 'TTY:'; node '${renderer}'
      printf 'STDERR-PIPE:'; node '${renderer}' 2> '${sandbox.scratch}/recovery'; /bin/cat '${sandbox.scratch}/recovery'
      export NO_COLOR=0 FORCE_COLOR=1
      printf 'NO-COLOR:'; node '${renderer}'
      export NO_COLOR='' TERM=dumb
      printf 'DUMB:'; node '${renderer}'
    `;
    const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', program], []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout.replace(/\r\n/gu, '\n');
    const failure = 'Ballin checkout is now fixture, but setup refresh failed. Fix the reported error, then run ';
    assert.include(output, `TTY:${failure}\x1b[1mballin self-update\x1b[0m to finish.\n`);
    for (const label of ['STDERR-PIPE', 'NO-COLOR', 'DUMB']) {
      assert.include(output, `${label}:${failure}\`ballin self-update\` to finish.\n`);
    }
    assert.notInclude(output, '`\x1b[1m');
  });

});

describe('bootstrap marker and choice palette on a real PTY', function() {
  this.timeout(30000);
  for (const file of ['install.sh', 'quickstart.sh']) it(`preserves neutral separators and declared defaults in ${file}`, () => {
    const sandbox = createSandbox();
    try {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const names = ['status_marker', 'choice_word', 'prompt_choices', ...(file === 'quickstart.sh' ? ['prompt_options'] : [])];
      const helpers = names.map((name) => {
        const helper = source.match(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?^\\}', 'mu'))?.[0];
        assert.isString(helper); return helper;
      }).join('\n');
      const program = `${helpers}
        export TERM=xterm NO_COLOR=''
        for role in prompt warning info success failure; do status_marker "$role"; printf ' Message.\\n'; done
        printf 'CHOICES:'; prompt_choices '[y/N]' n
        printf '\\nDEFAULT:['; choice_word NONE default; printf ']\\n'
        ${file === 'quickstart.sh' ? "printf 'STARTUP:'; prompt_options 'login/bashrc; Enter to skip'; printf '\\n'" : ''}
        { for role in prompt warning info success failure; do status_marker "$role"; printf ' Message.\\n'; done; } > '${sandbox.scratch}/palette'
        printf 'PIPE:'; /bin/cat '${sandbox.scratch}/palette'
        export TERM=dumb
        printf 'DUMB:'; for role in prompt warning info success failure; do status_marker "$role"; printf ' Message.\\n'; done
        export TERM=xterm NO_COLOR=0 FORCE_COLOR=1
        printf 'NO-COLOR:'; for role in prompt warning info success failure; do status_marker "$role"; printf ' Message.\\n'; done
        printf 'PLAIN:'; prompt_choices '[y/N]' n; status_marker success; printf ' Done.\\n'
      `;
      const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', program], []);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      for (const [marker, sgr] of [['?', '1;32'], ['!', '0;33'], ['i', '0;34'], ['✓', '0;32'], ['✗', '0;31']]) {
        assert.include(output, `\x1b[${sgr}m${marker}\x1b[0m Message.\n`);
      }
      assert.include(output, 'CHOICES:[y/N] ');
      assert.include(output, 'DEFAULT:[NONE]\n');
      if (file === 'quickstart.sh') assert.include(output, 'STARTUP:[login/bashrc; Enter to skip]\n');
      for (const label of ['PIPE', 'DUMB', 'NO-COLOR']) assert.include(output, `${label}:? Message.\n! Message.\ni Message.\n✓ Message.\n✗ Message.\n`);
      assert.include(output, 'PLAIN:[y/N] ✓ Done.\n');
    } finally { cleanupSandbox(sandbox.root); }
  });
});
