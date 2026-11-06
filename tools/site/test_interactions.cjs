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
    await handlers.click({ target: { closest: () => button } });
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, expected);
  }
}

(async () => {
  await exercise(async text => { assert.equal(text, '<actual & matching>\n'); }, 'Copied text.');
  await exercise(async () => { throw Error('Clipboard denied'); }, 'Could not copy. Select the text or use Download text.');
  await exercise(null, 'Could not copy. Select the text or use Download text.');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
