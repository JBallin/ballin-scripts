const fs = require('fs');
const path = require('path');
const { supportsHyperlinks, terminalDocumentation, terminalProse, terminalUrls, stripAnsi, visibleWidth } = require('../commands/terminalStyle.ts');
const { formatHelp } = require('../commands/help_format.ts');
const { createSandbox, cleanupSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');
import type { Sandbox } from './helpers/onboarding.ts';

const tty = { isTTY: true, columns: 18 };
const capable = { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' };
const guide = 'getballin.com/docs/installation.html#health-and-recovery';
const native = (label: string, url = 'https://' + guide): string => `\x1b]8;;${url}\x1b\\\x1b[34m${label}\x1b[0m\x1b]8;;\x1b\\`;

describe('documentation link rendering', () => {
  for (const version of ['3.1.0', '3.5.0', '4.0']) it(`recognizes versioned iTerm2 ${version}`, () => {
    assert.isTrue(supportsHyperlinks(tty, { ...capable, TERM_PROGRAM_VERSION: version }));
  });
  it('recognizes versioned WezTerm and keeps unknown builds conservative', () => {
    assert.isTrue(supportsHyperlinks(tty, { TERM: 'wezterm', TERM_PROGRAM: 'WezTerm', TERM_PROGRAM_VERSION: '20240203-110809-5046fc22' }));
    assert.isFalse(supportsHyperlinks(tty, { TERM: 'wezterm', TERM_PROGRAM: 'WezTerm' }));
  });
  for (const overrides of [
    { TERM_PROGRAM: 'Apple_Terminal' }, { TERM_PROGRAM: '' }, { TERM_PROGRAM_VERSION: '' },
    { TERM_PROGRAM_VERSION: '3.0.0' }, { TERM_PROGRAM_VERSION: 'unknown' },
    { TERM: 'dumb' }, { TERM: '' }, { TERM: 'screen-256color' },
    { NO_COLOR: '0', FORCE_COLOR: '1' }, { NO_COLOR: 'yes' }, { TMUX: 'fixture' },
    { STY: 'fixture' }, { SSH_CONNECTION: 'fixture' }, { SSH_TTY: '/dev/fixture' }, { CI: 'true' },
  ]) it(`falls back for ${JSON.stringify(overrides)}`, () => {
    const env = { ...capable, ...overrides };
    assert.isFalse(supportsHyperlinks(tty, env));
    const output = terminalDocumentation('Installation details', guide, tty, env);
    assert.equal(stripAnsi(output), 'i Installation details: ' + guide);
    assert.notInclude(output, '\x1b]'); assert.notInclude(output, '\n');
    if (env.NO_COLOR || env.TERM === 'dumb') assert.notInclude(output, '\x1b');
    else assert.include(output, '\x1b[34m' + guide + '\x1b[0m');
  });
  it('uses blue native labels with full HTTPS targets and no forced underline', () => {
    const output = terminalDocumentation('Installation details', guide, tty, capable);
    assert.equal(output, '\x1b[0;34mi\x1b[0m ' + native('Installation details'));
    assert.notInclude(output, '\x1b[4m'); assert.include(output, '\x1b[34mInstallation details\x1b[0m');
    assert.equal(visibleWidth(output), 'i Installation details'.length);
  });
  for (const program of ['Apple_Terminal', 'iTerm.app', 'WezTerm', 'unknown', '']) {
    it(`keeps the homepage visible and blue without OSC 8 for ${program || 'missing terminal identity'}`, () => {
      const env = { ...capable, TERM_PROGRAM: program };
      const address = program === 'Apple_Terminal' ? 'getballin.com' : 'getballin.com/';
      for (const url of ['getballin.com', 'getballin.com/', 'https://getballin.com', 'https://getballin.com/']) {
        const output = terminalDocumentation('Project and documentation', url, tty, env);
        assert.equal(output, '\x1b[0;34mi\x1b[0m Project and documentation: \x1b[34m' + address + '\x1b[0m');
        assert.notInclude(output, '\x1b]');
        assert.notInclude(output, 'https://');
        assert.equal(visibleWidth(output), ('i Project and documentation: ' + address).length);
      }
      const row = 'i Project and documentation: getballin.com/';
      for (const format of [terminalProse, formatHelp]) {
        const output = format(row, tty, env);
        assert.equal(stripAnsi(output), 'i Project and documentation: ' + address);
        assert.notInclude(output, '\n');
        assert.notInclude(output, '\x1b]');
      }
    });
  }
  for (const program of ['Apple_Terminal', 'iTerm.app', 'unknown']) {
    it(`preserves homepage text without ANSI for plain output (${program})`, () => {
      for (const mode of [
        { stream: { isTTY: false }, env: { FORCE_COLOR: '1' } },
        { stream: tty, env: { NO_COLOR: '1', FORCE_COLOR: '1' } },
        { stream: tty, env: { TERM: 'dumb', FORCE_COLOR: '1' } },
      ]) {
        const output = terminalDocumentation('Project and documentation', 'getballin.com/', mode.stream,
          { ...capable, TERM_PROGRAM: program, ...mode.env });
        assert.equal(output, 'i Project and documentation: ' + (program === 'Apple_Terminal' ? 'getballin.com' : 'getballin.com/'));
        assert.notInclude(output, '\x1b');
      }
    });
  }
  it('uses the receiving stream and never emits controls into redirected captures', () => {
    const output = terminalDocumentation('Installation details', guide, { isTTY: false }, { ...capable, FORCE_COLOR: '1' });
    assert.equal(output, 'i Installation details: ' + guide);
    assert.notInclude(output, '\x1b');
    assert.include(terminalDocumentation('Installation details', guide, tty, capable), '\x1b]8;');
  });
  it('keeps URI payloads and native label styling intact during URL formatting', () => {
    const link = native('Visit https://example.com');
    assert.equal(terminalUrls(link, tty, capable), link);
    assert.equal(terminalUrls(link + '\nhttps://cli.github.com/', tty, capable), link + '\n\x1b[34mhttps://cli.github.com/\x1b[0m');
    assert.equal(stripAnsi(link), 'Visit https://example.com');
    assert.equal(stripAnsi('\x1b]8;;https://example.com\x07Label\x1b]8;;\x07'), 'Label');
  });
  for (const url of ['http://example.com/guide', 'getballin.com/\x1b]8;;bad', 'https://example.com/\x07', 'https://']) {
    it(`refuses unsafe or non-HTTPS hyperlink target ${JSON.stringify(url)}`, () => {
      const output = terminalDocumentation('Details', url, tty, capable);
      assert.notInclude(output, '\x1b]'); assert.notInclude(output, '\x07');
    });
  }
  it('keeps labels and visible fallback URLs on one logical help/prose row', () => {
    const row = 'i Installation details: ' + guide;
    for (const format of [terminalProse, formatHelp]) {
      assert.equal(stripAnsi(format(row, tty, capable)), 'i Installation details');
      assert.equal(stripAnsi(format(row, tty, {})), row);
      assert.notInclude(format(row, tty, capable), '\n');
      assert.notInclude(format(row, tty, {}), '\n');
    }
    const backup = 'i Proposed backup: https://github.com/fixture-user/private-backup';
    assert.equal(stripAnsi(terminalProse(backup, { ...tty, columns: 120 }, capable, { colorUrls: false })), backup);
    assert.notInclude(terminalProse(backup, tty, capable, { colorUrls: false }), '\x1b]');
  });
});

describe('standalone documentation links on isolated PTYs', function() {
  this.timeout(sandboxSuiteTimeout);
  let sandbox: Sandbox;
  afterEach(() => { if (sandbox) cleanupSandbox(sandbox.root); });
  for (const file of ['install.sh', 'quickstart.sh']) for (const mode of ['supported', 'WezTerm', 'unknown', 'NO_COLOR', 'dumb', 'tmux', 'ssh']) {
    it(`preserves ${file} supported, fallback and stream contracts (${mode})`, () => {
      sandbox = createSandbox();
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const helpers = ['status_marker', 'url_reference', 'supports_hyperlinks', 'documentation_pointer'].map((name) => {
        const value = source.match(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?^\\}', 'mu'))?.[0];
        assert.isString(value); return value;
      }).join('\n');
      const overrides: Record<string, string> = {
        supported: '', WezTerm: 'TERM_PROGRAM=WezTerm; TERM_PROGRAM_VERSION=20240203-110809-5046fc22;',
        unknown: 'TERM_PROGRAM=Apple_Terminal;', NO_COLOR: 'NO_COLOR=1;', dumb: 'TERM=dumb;',
        tmux: 'TMUX=fixture;', ssh: 'SSH_TTY=/dev/fixture;',
      };
      const script = `${helpers}\nunset NO_COLOR TMUX STY SSH_TTY SSH_CONNECTION CI
export TERM=xterm-256color TERM_PROGRAM=iTerm.app TERM_PROGRAM_VERSION=3.5.0
${overrides[mode]}
printf 'OUT:'; documentation_pointer 'Details' '${guide}'
printf 'PIPE:'; documentation_pointer 'Details' '${guide}' | /bin/cat
printf 'ERR:' >&2; documentation_pointer 'Details' '${guide}' 2
`;
      const result = runInteractiveSetup(sandbox, ['/bin/bash', '-c', script], []);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout.replace(/\r\n/gu, '\n');
      assert.include(output, 'PIPE:i Details: ' + guide + '\n');
      const supported = mode === 'supported' || mode === 'WezTerm';
      for (const prefix of ['OUT:', 'ERR:']) {
        if (supported) assert.include(output, prefix + '\x1b[0;34mi\x1b[0m ' + native('Details'));
        else if (mode === 'NO_COLOR' || mode === 'dumb') assert.include(output, prefix + 'i Details: ' + guide + '\n');
        else assert.include(output, prefix + '\x1b[0;34mi\x1b[0m Details: \x1b[34m' + guide + '\x1b[0m\n');
      }
      if (!supported) assert.notInclude(output, '\x1b]');
      if (mode === 'NO_COLOR' || mode === 'dumb') assert.notInclude(output, '\x1b');
    });
  }
});
