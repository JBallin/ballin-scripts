const { formatHelp } = require('../commands/help_format.ts');

describe('help layout', () => {
  it('wraps words and preserves paragraphs, lists, usage and examples', () => {
    assert.equal(formatHelp('One two three four five.\n\n  ballin backup read <snapshot> --file <path>\n\n- one two three four', { columns: 14 }),
      'One two three\nfour five.\n\n  ballin backup read <snapshot> --file <path>\n\n- one two\n  three four');
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
