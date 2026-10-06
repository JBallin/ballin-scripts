const { isUtf8 } = require('node:buffer');
const { snapshotByteLimit, recursiveEntryLimit, isReadableText } = require('./recursive_snapshot.ts');

type DirectoryEntry = { path: string; executable: boolean; bytes: Buffer };
type DirectorySnapshot = { version: 2; entries: DirectoryEntry[] };

class DirectorySnapshotError extends Error {}
const invalid = (): never => { throw new DirectorySnapshotError('not a supported bundle snapshot.'); };
const object = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const memberPath = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && !value.includes('\0')
  && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  && !value.split('\\').includes('..')
);
const base64Bytes = (value: unknown): Buffer => {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return invalid();
  return bytes;
};
const textBytes = (value: unknown): Buffer => {
  if (!Array.isArray(value)) return invalid();
  if (!value.every((line, index) => typeof line === 'string' && line.length > 0
    && line.indexOf('\n') === (line.endsWith('\n') ? line.length - 1 : -1)
    && (index === value.length - 1 || line.endsWith('\n')))) return invalid();
  const text = value.join('');
  const bytes = Buffer.from(text, 'utf8');
  if (!isReadableText(bytes) || bytes.toString('utf8') !== text) return invalid();
  return bytes;
};

// Decode only validated regular-file records; member paths never reach the filesystem.
const readDirectorySnapshot = (bytes: Buffer): DirectorySnapshot => {
  if (bytes.length > snapshotByteLimit) throw new DirectorySnapshotError('bundle snapshot exceeds inspection limits.');
  if (!isUtf8(bytes)) return invalid();
  let archive: unknown;
  try { archive = JSON.parse(bytes.toString('utf8')); } catch { return invalid(); }
  if (!object(archive) || archive.format !== 'ballin-directory' || archive.version !== 2
    || Object.keys(archive).length !== 3 || !Array.isArray(archive.entries) || archive.entries.length === 0) return invalid();
  if (archive.entries.length > recursiveEntryLimit) throw new DirectorySnapshotError('bundle snapshot exceeds inspection limits.');
  const paths = new Set<string>();
  const version = archive.version;
  const entries = archive.entries.map((entry: unknown): DirectoryEntry => {
    if (!object(entry) || Object.keys(entry).length !== 4 || !memberPath(entry.path)
      || typeof entry.executable !== 'boolean' || paths.has(entry.path)) return invalid();
    const bytes = entry.encoding === 'base64' ? base64Bytes(entry.content)
      : entry.encoding === 'utf8' ? textBytes(entry.content) : invalid();
    paths.add(entry.path);
    return { path: entry.path, executable: entry.executable, bytes };
  });
  return { version, entries };
};
const listDirectoryMembers = (entries: DirectoryEntry[]): string => `${entries.map((entry) => (
  entry.path.replace(/[\p{Cc}\u2028\u2029\p{Bidi_Control}]/gu, (character) => {
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped.length > 1 ? escaped : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })
)).join('\n')}\n`;
const readDirectoryMember = (entries: DirectoryEntry[], selected: string): Buffer => {
  const entry = entries.find((member) => member.path === selected);
  if (!entry) throw new DirectorySnapshotError('no matching file found in the bundle; use `--list` to find saved paths.');
  return entry.bytes;
};

module.exports = { DirectorySnapshotError, readDirectorySnapshot, listDirectoryMembers, readDirectoryMember };
export type { DirectoryEntry, DirectorySnapshot };
