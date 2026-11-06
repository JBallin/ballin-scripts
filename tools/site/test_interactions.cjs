const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../site/gallery.js'), 'utf8');

async function exercise(writeText, expected) {
  const handlers = {};
  const button = { hidden: true, disabled: false, dataset: { copy: 'text', status: 'status' } };
  const transcript = { textContent: '<actual & matching>\n' };
  const status = { textContent: '' };
  const document = {
    querySelectorAll: () => [button],
    addEventListener: (name, fn) => { handlers[name] = fn; },
    getElementById: id => ({ text: transcript, status })[id],
  };
  vm.runInNewContext(source, { document, navigator: writeText ? { clipboard: { writeText } } : {}, location: { hash: '' }, window: { addEventListener() {} } });
  assert.equal(button.hidden, false);
  for (let i = 0; i < 2; i++) {
    await handlers.click({ target: { closest: selector => selector === '[data-copy]' ? button : null } });
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, expected);
  }
}

function exerciseFragments() {
  const handlers = {}, frames = [], scrolled = [];
  const outer = { tagName: 'DETAILS', open: false, parentElement: null };
  const transcript = { tagName: 'DETAILS', open: false, parentElement: outer,
    matches: () => false, scrollIntoView: () => {
      assert.equal(transcript.open, true);
      assert.equal(outer.open, true);
      scrolled.push('text');
    } };
  const provenance = { open: false }, output = { open: false };
  const entry = { tagName: 'ARTICLE', parentElement: outer, matches: () => true,
    querySelector: selector => selector === 'details:not(.provenance)' ? output : provenance,
    scrollIntoView: () => { assert.equal(output.open, true); scrolled.push('entry'); } };
  const location = new URL('https://example.test/project/viewer.html');
  const document = { querySelectorAll: () => [], addEventListener: (name, fn) => { handlers[name] = fn; },
    getElementById: id => ({ 'text target': transcript, entry })[id] };
  const window = { addEventListener: (name, fn) => { handlers[name] = fn; },
    requestAnimationFrame: fn => { frames.push(fn); } };
  vm.runInNewContext(source, { document, window, location, URL });
  const click = (href, overrides = {}) => handlers.click({ button: 0,
    target: { closest: selector => selector === 'a[href]' ? { href } : null }, ...overrides });
  const frame = () => frames.splice(0).forEach(fn => fn());
  const flush = () => { frame(); frame(); };
  return (async () => {
    // A first click opens both levels immediately, then aligns after layout.
    await click('#text%20target');
    assert.equal(transcript.open, true); assert.equal(outer.open, true);
    assert.deepEqual(scrolled, []); frame(); assert.deepEqual(scrolled, []); frame();
    assert.deepEqual(scrolled, ['text']);
    // Closing it and repeating the unchanged fragment still reopens/re-aligns it.
    location.hash = '#text%20target'; transcript.open = false; outer.open = false;
    await click(location.href); flush();
    assert.equal(transcript.open, true); assert.deepEqual(scrolled, ['text', 'text']);
    // An already expanded target also aligns. Modified/cross-document clicks do not mutate it.
    await click('#text%20target'); flush(); assert.equal(scrolled.length, 3);
    transcript.open = false;
    for (const options of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      await click('#text%20target', options);
    }
    await click('https://example.test/other.html#text%20target'); flush(); assert.equal(transcript.open, false);
    // History/deep-link changes work and never open provenance instead of output.
    location.hash = '#entry'; handlers.hashchange(); flush();
    assert.equal(output.open, true); assert.equal(provenance.open, false);
    // A newer fragment supersedes an older pending scroll.
    const before = scrolled.length;
    await click('#text%20target'); await click('#entry'); flush();
    assert.deepEqual(scrolled.slice(before), ['entry']);
    // Malformed/missing fragments leave the page alone.
    await click('#%invalid'); await click('#missing'); flush();
    assert.equal(scrolled.length, before + 1);
  })();
}

(async () => {
  await exercise(async text => { assert.equal(text, '<actual & matching>\n'); }, 'Copied text.');
  await exercise(async () => { throw Error('Clipboard denied'); }, 'Could not copy. Select the text or use Download text.');
  await exercise(null, 'Could not copy. Select the text or use Download text.');
  await exerciseFragments();
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
