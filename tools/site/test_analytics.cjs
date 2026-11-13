// Offline DOM fixtures: never load Cloudflare or send a page view.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../site/analytics.js'), 'utf8');
const token = 'a'.repeat(32);
function load(origin, value = token, configPresent = true) {
  const scripts = [];
  const document = {
    currentScript: configPresent ? { dataset: { token: value, origin: 'https://getballin.com' } } : null,
    createElement: (tag) => { assert.equal(tag, 'script'); return { dataset: {} }; },
    head: { appendChild: (element) => scripts.push(element) },
  };
  vm.runInNewContext(source, { document, window: { location: { origin } } });
  return scripts;
}
for (const origin of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://getballin.com', 'https://preview.example', 'https://getballin.com.evil.example', 'https://jballin.github.io']) {
  assert.deepEqual(load(origin), []);
}
for (const invalid of ['', 'bad', 'A'.repeat(32), undefined]) {
  // Explicit undefined must not use the function's default fixture token.
  assert.deepEqual(load('https://getballin.com', invalid === undefined ? null : invalid), []);
}
assert.deepEqual(load('https://getballin.com', token, false), []);
const scripts = load('https://getballin.com');
assert.equal(scripts.length, 1);
assert.equal(scripts[0].src, 'https://static.cloudflareinsights.com/beacon.min.js');
assert.equal(scripts[0].defer, true);
assert.deepEqual(JSON.parse(scripts[0].dataset.cfBeacon), { token });
console.log('Analytics loader offline contracts passed');
