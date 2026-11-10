const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { collectRelease, isVerifiedRelease } = require('./release-provenance.cjs');
const sha = 'a'.repeat(40), tagSha = 'b'.repeat(40);
function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-release-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  for (const file of ['bin/ballin', 'commands/ballin.ts', 'commands/installation.ts', 'config/.defaultConfig.json', 'completions/_ballin', 'completions/ballin.bash']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'fixture\n');
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ballin-scripts', version: options.version || '1.0.0', engines: { node: '>=24.12' }, ballin: { installerProtocol: 2, ...(options.legacy ? {} : { packageSchema: 3 }) } }));
  fs.writeFileSync(path.join(root, '.nvmrc'), '26\n');
  if (options.unsafe) fs.symlinkSync('/tmp', path.join(root, 'link'));
  const archive = path.join(base, 'input.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', base, 'source']);
  const bytes = fs.readFileSync(archive), urls = []; let releases = 0, hops = 0;
  const transport = async (url, limits) => {
    urls.push(url); assert.ok(limits.limit > 0); assert.equal(limits.timeout, 60000);
    if (options.error) throw Error('fixture download failure');
    let value;
    if (url.includes('/releases/tags/')) { releases++; value = { id: options.changed && releases > 1 ? 2 : 1, tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-11-10T00:00:00Z', ...options.release }; }
    else if (url.includes('/git/ref/tags/')) value = { object: { type: options.annotated || options.deep || options.eight ? 'tag' : 'commit', sha: options.annotated || options.deep || options.eight ? tagSha : options.moved && releases > 1 ? tagSha : sha } };
    else if (url.includes('/git/tags/')) { hops++; value = { object: { type: options.deep || (options.eight && hops % 8 !== 0) ? 'tag' : 'commit', sha } }; }
    else { assert.equal(url, `https://codeload.github.com/JBallin/ballin-scripts/tar.gz/${sha}`); return bytes; }
    return Buffer.from(JSON.stringify(value));
  };
  return { args: { formula: 'ballin-local/choice/ballin-experiment', tag: 'v1.0.0', destination: path.join(base, 'output'), transport }, urls, bytes };
}
test('collects exact lightweight and annotated stable publications with bound archive bytes', async t => {
  for (const annotated of [false, true]) {
    const f = fixture(t, { annotated }); const result = await collectRelease(f.args);
    assert.equal(result.sourceRevision, sha); assert.equal(result.version, '1.0.0');
    assert.equal(result.minimumNode, '24.12.0'); assert.equal(result.nodeMajor, 26);
    assert.deepEqual(result.selection, { kind: 'release', value: 'v1.0.0', releaseId: '1' });
    assert.equal(result.archiveSha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
    assert.deepEqual(fs.readFileSync(result.archive), f.bytes);
    assert.equal(isVerifiedRelease(result), true);
    assert.equal(isVerifiedRelease(JSON.parse(JSON.stringify(result))), false);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.selection));
    assert.equal(f.urls.filter(u => u.includes('/releases/tags/')).length, 2);
    await assert.rejects(collectRelease(f.args), /EEXIST/);
  }
});
test('rejects unpublished, mismatched, malformed and changed release identity', async t => {
  for (const options of [{ release: { draft: true } }, { release: { prerelease: true } }, { release: { tag_name: 'v2.0.0' } }, { release: { id: 0 } }, { release: { id: Number.MAX_SAFE_INTEGER + 1 } }, { release: { published_at: null } }, { changed: true }, { moved: true }, { deep: true }, { version: '2.0.0' }, { unsafe: true }, { error: true }, { legacy: true }]) {
    const f = fixture(t, options); await assert.rejects(collectRelease(f.args), /Release collection failed/);
    assert.equal(fs.existsSync(path.join(f.args.destination, 'provenance.json')), false);
  }
});
test('refuses selectors, reused destinations and malformed/oversized transport before success', async t => {
  const f = fixture(t);
  await assert.rejects(collectRelease({ ...f.args, tag: 'latest' }), /exact stable/);
  await assert.rejects(collectRelease({ ...f.args, destination: 'relative' }), /absolute/);
  for (const data of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1), 'not bytes']) {
    const next = fixture(t); await assert.rejects(collectRelease({ ...next.args, transport: async () => data }), /Invalid or oversized/);
  }
});
test('stable formula derives all identity from collection and refuses JSON promotion or overrides', async t => {
  const { generate } = require('./generate-formula.cjs');
  const f = fixture(t); const result = await collectRelease(f.args);
  const formula = generate({ verifiedRelease: result });
  assert.match(formula, /"schema":3/); assert.match(formula, /version '1.0.0'/);
  assert.match(formula, /"runtime":\{"nodeMajor":26,"minimumNode":"24.12.0"\}/);
  assert.ok(formula.includes(result.archiveUrl)); assert.ok(formula.includes(result.archiveSha256));
  assert.match(execFileSync('/usr/bin/ruby', ['-c'], { input: formula, encoding: 'utf8' }), /Syntax OK/);
  assert.equal(fs.readFileSync(path.join(f.args.destination, 'ballin-experiment.rb'), 'utf8'), formula);
  assert.throws(() => generate({ verifiedRelease: JSON.parse(JSON.stringify(result)) }), /in-process/);
  for (const delta of [{ archive: result.archive }, { checksum: result.archiveSha256 }, { sourceRevision: sha }, { nodeMajor: 24 }]) assert.throws(() => generate({ verifiedRelease: result, ...delta }), /overridden/);
  fs.appendFileSync(result.archive, 'changed');
  assert.throws(() => generate({ verifiedRelease: result }), /checksum mismatch/);
});

test('allows exactly eight annotated tag hops', async t => {
  const f = fixture(t, { eight: true });
  assert.equal((await collectRelease(f.args)).sourceRevision, sha);
  assert.equal(f.urls.filter(url => url.includes('/git/tags/')).length, 16);
});

test('requires qualified owner before creating output or making requests', async t => {
  for (const formula of [undefined, 'ballin-experiment', 'other/tap/ballin', 'bad;owner/tap/ballin-experiment', '-owner/tap/ballin-experiment']) {
    const f = fixture(t);
    await assert.rejects(collectRelease({ ...f.args, formula }), /qualified experimental formula/);
    assert.equal(f.urls.length, 0);
    assert.equal(fs.existsSync(f.args.destination), false);
  }
  const f = fixture(t); const result = await collectRelease(f.args);
  assert.equal(result.formula, f.args.formula);
  const { generate } = require('./generate-formula.cjs');
  assert.ok(generate({ verifiedRelease: result }).includes(`"formula":"${f.args.formula}"`));
  assert.throws(() => generate({ verifiedRelease: result, formula: 'another/tap/ballin-experiment' }), /owner cannot be overridden/);
});
test('protocol 2 alone cannot promote an archive to package schema 3', async t => {
  const f = fixture(t, { legacy: true });
  await assert.rejects(collectRelease(f.args), /does not support package provenance schema 3/);
  assert.equal(fs.existsSync(path.join(f.args.destination, 'provenance.json')), false);
  assert.equal(fs.existsSync(path.join(f.args.destination, 'ballin-experiment.rb')), false);
});
