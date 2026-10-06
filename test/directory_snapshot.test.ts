const fs = require('fs');
const os = require('os');
const path = require('path');
const { DirectorySnapshotError, readDirectorySnapshot, listDirectoryMembers, readDirectoryMember } = require('../commands/directory_snapshot.ts');
const { recursiveSnapshot, snapshotByteLimit, recursiveEntryLimit, encodeDirectoryEntry, SnapshotLimitError } = require('../commands/recursive_snapshot.ts');

describe('directory snapshot inspection', () => {
  const entry = { path: 'example/SKILL.md', executable: true, encoding: 'base64', content: Buffer.from('# Example\r\n').toString('base64') };
  const archive = (entries: unknown[] = [entry], extra = {}): Buffer => Buffer.from(JSON.stringify({ format: 'ballin-directory', version: 2, entries, ...extra }));
  const reject = (bytes: Buffer): void => { assert.throws(() => readDirectorySnapshot(bytes), DirectorySnapshotError); };

  it('reads version-2 binary archives and retains their metadata', () => {
    const { version, entries: members } = readDirectorySnapshot(archive());
    assert.equal(version, 2);
    assert.deepEqual(members, [{ path: entry.path, executable: true, bytes: Buffer.from('# Example\r\n') }]);
    assert.deepEqual(JSON.parse(listDirectoryMembers(members)), [{ path: entry.path, executable: true, bytes: 11 }]);
    assert.deepEqual(readDirectoryMember(members, entry.path), Buffer.from('# Example\r\n'));
  });
  it('reads old namespaced and new direct Claude skill paths without rewriting saved paths', () => {
    for (const name of ['synced/old-collection/example/SKILL.md', 'example/SKILL.md']) {
      const { entries } = readDirectorySnapshot(archive([{ ...entry, path: name }]));
      assert.equal(JSON.parse(listDirectoryMembers(entries))[0].path, name);
      assert.deepEqual(readDirectoryMember(entries, name), Buffer.from('# Example\r\n'));
      const other = name.startsWith('synced/') ? 'example/SKILL.md' : 'synced/old-collection/example/SKILL.md';
      assert.throws(() => readDirectoryMember(entries, other), DirectorySnapshotError);
    }
  });
  it('round-trips captured Unicode, CRLF, no-final-newline, empty and binary files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-directory-read-')));
    const files = new Map([
      ['nested/雪.md', Buffer.from('é\r\nlast')], ['empty', Buffer.alloc(0)],
      ['binary', Buffer.from([0, 255, 128, 10])], ['run.sh', Buffer.from('$(touch forbidden)')],
      ['bom.md', Buffer.from('\ufeffé\n雪\r\nlast\r')], ['controls', Buffer.from('nul\0\u009b')],
      ['quotes', Buffer.from('"quoted"\\tab\t\n')], ['C:relative', Buffer.from('literal filename')],
      ['\\literal', Buffer.from('literal backslash')],
      ['del', Buffer.from('\x7f')], ['c1', Buffer.from('\u009b')],
    ]);
    try {
      for (const [name, bytes] of files) {
        const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { mode: name === 'run.sh' ? 0o755 : 0o600 });
      }
      const first = recursiveSnapshot(root);
      assert.equal(recursiveSnapshot(root), first);
      const limit = Buffer.byteLength(first);
      assert.equal(recursiveSnapshot(root, false, false, { maxBytes: limit }), first);
      assert.throws(() => recursiveSnapshot(root, false, false, { maxBytes: limit - 1 }), SnapshotLimitError);
      const { version, entries: members } = readDirectorySnapshot(Buffer.from(first));
      assert.equal(version, 2);
      for (const [name, bytes] of files) assert.deepEqual(readDirectoryMember(members, name), bytes);
      assert.isTrue(members.find((member: { path: string }) => member.path === 'run.sh').executable);
      const stored = JSON.parse(first);
      assert.equal(stored.entries.find((member: { path: string }) => member.path === 'binary').encoding, 'base64');
      assert.equal(stored.entries.find((member: { path: string }) => member.path === 'controls').encoding, 'base64');
      assert.deepEqual(stored.entries.find((member: { path: string }) => member.path === 'bom.md').content, ['\ufeffé\n', '雪\r\n', 'last\r']);
      assert.deepEqual(stored.entries.find((member: { path: string }) => member.path === 'empty').content, []);
      assert.isFalse(fs.existsSync(path.join(root, 'forbidden')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('escapes control characters in listed paths without altering stored paths', () => {
    const directional = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    const separators = '\u2028\u2029';
    const name = `nested/\x1b[31m\tline\n\u009b${directional}${separators}.md`;
    const listed = listDirectoryMembers(readDirectorySnapshot(archive([{ ...entry, path: name, executable: false }])).entries);
    assert.notInclude(listed, '\x1b'); assert.notInclude(listed, '\t');
    assert.notInclude(listed, '\u009b');
    for (const character of directional + separators) assert.notInclude(listed, character);
    assert.equal(JSON.parse(listed)[0].path, name);
  });
  for (const value of ['broken', 'null', '[]', '1', '"text"']) it(`rejects invalid archive ${value}`, () => reject(Buffer.from(value)));
  it('rejects invalid UTF-8 without replacing path bytes', () => reject(Buffer.from([0xff])));
  for (const extra of [{ format: 'other' }, { version: 3 }, { version: 1 }, { entries: null }, { link: 'unsafe' }]) {
    it('rejects unsupported schema/version without partial output', () => reject(archive([entry], extra)));
  }
  it('rejects empty archives and duplicate paths', () => { reject(archive([])); reject(archive([entry, entry])); });
  for (const name of ['', '.', '..', '/absolute', 'a/../b', 'a\\..\\b', 'a/./b', 'a//b', 'a/', 'nul\0file']) {
    it(`rejects unsafe member path ${JSON.stringify(name)}`, () => reject(archive([{ ...entry, path: name }])));
  }
  for (const value of [null, [], {}, { ...entry, path: 1 }, { ...entry, executable: 1 }, { ...entry, content: 1 }, { ...entry, target: 'link' }]) {
    it('rejects invalid member metadata and unsupported links', () => reject(archive([value])));
  }
  for (const content of ['abc', 'YQ', 'YQ=\n', '!!!!', 'YQ===', 'YR==', 'YWJ=']) {
    it(`rejects noncanonical Base64 ${JSON.stringify(content)}`, () => reject(archive([{ ...entry, content }])));
  }
  it('validates every entry before selecting a valid member', () => reject(archive([entry, { ...entry, path: '../unsafe' }])));
  it('rejects oversized archives and excessive entries', () => {
    reject(Buffer.alloc(snapshotByteLimit + 1));
    reject(archive(Array.from({ length: recursiveEntryLimit + 1 }, (_, index) => ({ ...entry, path: String(index) }))));
  });
  it('handles a large bounded payload without a recursive pattern limit', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 255);
    const { entries: members } = readDirectorySnapshot(archive([{ ...entry, content: bytes.toString('base64') }]));
    assert.deepEqual(readDirectoryMember(members, entry.path), bytes);
  });
  it('reports a missing exact member without disclosing the requested path', () => {
    assert.throws(() => readDirectoryMember(readDirectorySnapshot(archive()).entries, 'PRIVATE_NAME'), DirectorySnapshotError, 'no matching file found in the bundle');
  });
  for (const content of ['text', [1], [''], ['a', 'b'], ['a\nb\n'], ['nul\0'], ['\ud800']]) {
    it('rejects malformed UTF-8 line arrays', () => reject(archive([{ ...entry, encoding: 'utf8', content }], { version: 2 })));
  }
  it('rejects unsupported encoding and duplicate v2 paths', () => {
    reject(archive([{ ...entry, encoding: 'gzip' }], { version: 2 }));
    reject(archive([{ ...entry, encoding: 'base64' }, { ...entry, encoding: 'base64' }], { version: 2 }));
  });
  it('bounds dense newline expansion before allocating any content lines', () => {
    const originalPush = Array.prototype.push;
    let pushed = 0;
    try {
      Array.prototype.push = function(...items) {
        if (items.includes('\n')) pushed++;
        return originalPush.apply(this, items);
      };
      assert.throws(() => encodeDirectoryEntry('dense', false, Buffer.alloc(2 * 1024 * 1024, 10), snapshotByteLimit), SnapshotLimitError);
      assert.equal(pushed, 0);
    } finally { Array.prototype.push = originalPush; }
  });
  it('honors exact serialized entry budgets for text, empty and binary bytes', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('"é"\\\t\r\n\nlast'), Buffer.from([0, 255])]) {
      const captured = encodeDirectoryEntry('example', false, bytes, snapshotByteLimit);
      assert.deepEqual(encodeDirectoryEntry('example', false, bytes, captured.size), captured);
      assert.throws(() => encodeDirectoryEntry('example', false, bytes, captured.size - 1), SnapshotLimitError);
      const stored = `${JSON.stringify({ format: 'ballin-directory', version: 2, entries: [captured.entry] }, null, 2)}\n`;
      assert.deepEqual(readDirectorySnapshot(Buffer.from(stored)).entries[0].bytes, bytes);
    }
  });
});
