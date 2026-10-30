const { formatHelp } = require('../commands/help_format.ts');

describe('help layout', () => {
  it('keeps compact usage inline and aligns alternative synopses', () => {
    assert.equal(formatHelp('Usage: ballin config [get [key]]\n       ballin config reset\n\nRead local settings.\n', { columns: 80 }),
      'Usage: ballin config [get [key]]\n       ballin config reset\n\nRead local settings.\n');
    assert.equal(formatHelp('Usage: ballin backup setup [repository-name]\n       ballin backup setup\n', { columns: 40 }),
      'Usage: ballin backup setup\n       [repository-name]\n       ballin backup setup\n');
    assert.equal(formatHelp('Usage: ballin config [get [key]]', { columns: 20 }),
      'Usage: ballin config\n       [get [key]]');
    assert.equal(formatHelp('Usage: ballin setup', { columns: 12 }), 'Usage:\n    ballin\n    setup');
  });

  it('emphasizes help structure without styling descriptions or documentation labels', () => {
    const text = 'Usage: ballin doctor [--verbose]\n\nCheck readiness.\n\nOptions:\n    --verbose  show full details\n\nExisting backup: Keep the saved destination.\n\n🔗 Details:\nhttps://example.com/guide\n';
    assert.equal(formatHelp(text, { columns: 80, isTTY: true }, { TERM: 'xterm' }),
      'Usage: \x1b[1mballin doctor [--verbose]\x1b[0m\n\nCheck readiness.\n\n\x1b[1mOptions:\x1b[0m\n    \x1b[1m--verbose\x1b[0m  show full details\n\n\x1b[1mExisting backup:\x1b[0m Keep the saved destination.\n\n🔗 Details:\nhttps://example.com/guide\n');
    for (const mode of [
      { isTTY: false, env: { TERM: 'xterm', FORCE_COLOR: '1' } },
      { isTTY: true, env: { TERM: 'dumb', FORCE_COLOR: '1' } },
      { isTTY: true, env: { TERM: 'xterm', NO_COLOR: '1', FORCE_COLOR: '1' } },
    ]) assert.equal(formatHelp(text, { columns: 80, isTTY: mode.isTTY }, mode.env), text);
  });

  it('aligns multiword table terms and styles copyable examples on supported terminals', () => {
    assert.equal(formatHelp('    --file <path>  print original bytes\n', { columns: 30, isTTY: true }, { TERM: 'xterm' }),
      '    \x1b[1m--file <path>\x1b[0m\n        print original bytes\n');
    assert.equal(formatHelp('Examples:\n    ballin backup read zshrc.sh\n', { columns: 80, isTTY: true }, { TERM: 'xterm' }),
      '\x1b[1mExamples:\x1b[0m\n    \x1b[1mballin backup read zshrc.sh\x1b[0m\n');
  });

  it('wraps words and preserves paragraphs and lists', () => {
    assert.equal(formatHelp('One two three four five.\n\n- one two three four', { columns: 14 }),
      'One two three\nfour five.\n\n- one two\n  three four');
  });

  it('keeps optional syntax together and concrete wrapped examples copyable', () => {
    assert.equal(formatHelp('Usage: ballin backup read <snapshot> [--list | --file <path>]', { columns: 40 }),
      'Usage: ballin backup read <snapshot>\n       [--list | --file <path>]');
    const example = '    ballin backup read codex_skills.bundle.json --file example/SKILL.md';
    const wrapped = formatHelp(example, { columns: 40 });
    assert.equal(wrapped, '    ballin backup read \\\n        codex_skills.bundle.json \\\n        --file example/SKILL.md');
    assert.equal(wrapped.replace(/\\\n */gu, '').trim(), example.trim());
    const quoted = formatHelp('    ballin backup read bundle --file "skill name/SKILL.md"', { columns: 40 });
    assert.include(quoted, '"skill name/SKILL.md"');
  });

  it('retains numbered list indentation', () => {
    assert.equal(formatHelp('1. one two three four', { columns: 14 }), '1. one two\n   three four');
  });

  it('keeps backtick syntax and URLs intact', () => {
    assert.equal(formatHelp('Use `ballin backup read <snapshot> --file <path>` now.\nSee https://example.com/long/path.', { columns: 20 }),
      'Use\n`ballin backup read <snapshot> --file <path>`\nnow.\nSee\nhttps://example.com/long/path.');
  });

  it('keeps punctuation attached to protected syntax', () => {
    assert.equal(formatHelp('Run `ballin setup`. Next, use `--file <path>`; finish.', { columns: 30 }),
      'Run `ballin setup`. Next, use\n`--file <path>`; finish.');
  });

  it('aligns command descriptions, moving them below names on narrow terminals', () => {
    const row = '    update                update the Ballin-managed macOS development environment';
    assert.equal(formatHelp(row, { columns: 60 }), '    update                update the Ballin-managed macOS\n                          development environment');
    assert.equal(formatHelp(row, { columns: 40 }), '    update\n        update the Ballin-managed macOS\n        development environment');
  });

  it('measures ANSI emphasis by visible width', () => {
    assert.equal(formatHelp('One \x1b[1mtwo\x1b[0m three four', { columns: 13 }), 'One \x1b[1mtwo\x1b[0m three\nfour');
  });

  it('caps wide output at 80 and defaults unavailable or invalid widths to 80', () => {
    const prose = 'word '.repeat(30).trim();
    const expected = `${'word '.repeat(16).trim()}\n${'word '.repeat(14).trim()}`;
    for (const columns of [undefined, 0, -1, NaN, Infinity, 80, 120]) {
      assert.equal(formatHelp(prose, { columns }), expected);
    }
    assert.equal(formatHelp('one two', { columns: 1 }), 'one\ntwo');
    assert.equal(formatHelp('', { columns: 40 }), '');
  });
});
