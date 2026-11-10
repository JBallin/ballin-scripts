const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertExactSelection } = require('./selection-bridge.cjs');
function fixture() {
  const selection = { kind: 'release', value: 'v1.0.0', sha: 'a'.repeat(40), minimumNode: '24.12.0', releaseId: '1' };
  const options = { formula: 'ballin-local/choice/ballin-experiment', nodeMajor: 26 };
  const metadata = { manager: 'homebrew', schema: 3, formula: options.formula, version: '1.0.0', sourceRevision: selection.sha,
    archiveSha256: 'b'.repeat(64), selection: { kind: 'release', value: selection.value, releaseId: '1' }, runtime: { minimumNode: '24.12.0', nodeMajor: 26 } };
  return { selection, metadata, options };
}
test('accepts only the exact published release, owner and runtime', () => {
  const f = fixture(); assert.equal(assertExactSelection(f.selection, f.metadata, f.options), true);
});
test('development selectors do not become releases even at the same commit', () => {
  for (const kind of ['sha', 'branch', 'development', undefined]) {
    const f = fixture(); assert.throws(() => assertExactSelection({ ...f.selection, kind }, f.metadata, f.options), /exact published releases only/);
  }
});
test('fails closed on package ownership, historical release, provenance and runtime mismatch', () => {
  for (const change of [m => { m.schema = 2; }, m => { m.manager = 'other'; }, m => { m.formula = 'other/tap/ballin'; }, m => { m.selection.kind = 'development'; }, m => { m.selection.value = 'v2.0.0'; }, m => { m.selection.releaseId = '2'; }, m => { m.sourceRevision = 'c'.repeat(40); }, m => { m.version = '2.0.0'; }, m => { m.archiveSha256 = 'bad'; }, m => { m.runtime.minimumNode = '24.13.0'; }, m => { m.runtime.nodeMajor = 24; }, m => { delete m.runtime; }]) {
    const f = fixture(); change(f.metadata); assert.throws(() => assertExactSelection(f.selection, f.metadata, f.options));
  }
  const f = fixture(); assert.throws(() => assertExactSelection(f.selection, f.metadata, { ...f.options, formula: 'ballin' }), /qualified/);
  assert.throws(() => assertExactSelection(f.selection, f.metadata, { ...f.options, nodeMajor: 22 }), /runtime/);
});
test('rejects malformed resolved selections rather than treating their fields as authority', () => {
  for (const delta of [{ value: 'latest' }, { releaseId: 1 }, { releaseId: '0' }, { sha: 'main' }, { minimumNode: '24' }]) {
    const f = fixture(); assert.throws(() => assertExactSelection({ ...f.selection, ...delta }, f.metadata, f.options), /Invalid resolved/);
  }
});
