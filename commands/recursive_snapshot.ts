const fs = require('fs');
const path = require('path');
const { isUtf8 } = require('node:buffer');

type RecursiveEntry = { path: string; executable: boolean; content: string };
type ReadableRecursiveEntry = { path: string; executable: boolean } & (
  { encoding: 'utf8'; content: string[] } | { encoding: 'base64'; content: string }
);
type SnapshotLimits = { maxBytes?: number; maxEntries?: number };
type RecursiveSelection = { markdownOnly?: boolean; rejectHardlinks?: boolean; claudeSkills?: boolean };
const snapshotByteLimit = 16 * 1024 * 1024;
const recursiveEntryLimit = 8192;
const claudeSyncBookkeeping = new Set(['manifest.json', '.staging', '.last-complete-round', '.trash']);
class SnapshotLimitError extends Error {
  constructor(kind: 'bytes' | 'entries', actual: number, limit: number) {
    super(`Snapshot ${kind} limit exceeded (${actual} > ${limit}).`);
  }
}
class SnapshotCwdError extends Error {}
class SnapshotSourceTypeError extends Error {}
let directoryPinned = false;
const sameDirectory = (left: import('fs').Stats, right: import('fs').Stats): boolean => (
  left.dev === right.dev && left.ino === right.ino && right.isDirectory()
);
const validatePath = (root: string, relative: string): void => {
  if (path.resolve(root) !== root || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
    throw new Error('Invalid snapshot path');
  }
};
const symlinkError = (): NodeJS.ErrnoException => (
  Object.assign(new Error('Symlinked snapshot source'), { code: 'ELOOP' })
);

// Private synchronous callbacks use only '.' or immediate names. Entering each
// directory pins its object as cwd; no later ancestor lookup can redirect them.
const inDirectory = <T>(root: string, relative: string, operation: () => T): T => {
  if (directoryPinned) throw new Error('Nested snapshot directory operation');
  validatePath(root, relative);
  const previous = process.cwd();
  const previousStat = fs.statSync('.');
  directoryPinned = true;
  try {
    const rootStat = fs.lstatSync(path.parse(root).root);
    process.chdir(path.parse(root).root);
    let expected = path.parse(root).root;
    if (process.cwd() !== expected || !sameDirectory(rootStat, fs.statSync('.'))) throw new Error('Snapshot directory changed');
    for (const name of path.join(root, relative).split(path.sep).filter(Boolean)) {
      const selected = fs.lstatSync(name);
      if (selected.isSymbolicLink()) throw symlinkError();
      if (!selected.isDirectory()) throw new Error('Snapshot directory changed');
      process.chdir(name);
      expected = path.join(expected, name);
      // Successful chdir clears Node's cwd cache: this first lookup is fresh.
      if (process.cwd() !== expected || !sameDirectory(selected, fs.statSync('.'))) throw new Error('Snapshot directory changed');
    }
    return operation();
  } finally {
    try {
      process.chdir(previous);
      if (process.cwd() !== previous || !sameDirectory(previousStat, fs.statSync('.'))) throw new Error('Snapshot caller changed');
    } catch {
      throw new SnapshotCwdError('Unable to restore snapshot working directory.');
    } finally { directoryPinned = false; }
  }
};

const requireSingleLink = (stat: import('fs').Stats, rejectHardlinks: boolean): void => {
  if (rejectHardlinks && stat.nlink !== 1) throw new Error('Hard-linked snapshot source');
};
const readableFileStat = (name: string, rejectHardlinks = false): import('fs').Stats => {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot source is not a regular file');
    requireSingleLink(stat, rejectHardlinks);
    return stat;
  } finally { fs.closeSync(fd); }
};
const fileStat = (root: string, relative: string, rejectHardlinks = false): import('fs').Stats => {
  validatePath(root, relative);
  return inDirectory(root, path.dirname(relative), () => readableFileStat(path.basename(relative), rejectHardlinks));
};
const sourceStat = (root: string, relative: string): import('fs').Stats => {
  validatePath(root, relative);
  return inDirectory(root, path.dirname(relative), () => fs.lstatSync(path.basename(relative)));
};
const requireWithinLimit = (kind: 'bytes' | 'entries', actual: number, limit: number): void => {
  if (actual > limit) throw new SnapshotLimitError(kind, actual, limit);
};

// Enumerate regular files without following symlinks. Metadata-only discovery
// uses this same traversal, so empty or generated-only sources stay absent.
const checkedPath = (root: string, relative: string): string => {
  if (sourceStat(root, relative).isSymbolicLink()) throw symlinkError();
  return path.join(root, relative);
};

const readBoundedFile = (file: string, maxBytes = snapshotByteLimit, rejectHardlinks = false): { bytes: Buffer; executable: boolean } => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot source is not a regular file');
    requireSingleLink(stat, rejectHardlinks);
    requireWithinLimit('bytes', stat.size, maxBytes);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) throw new Error('Snapshot source changed during capture');
      offset += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('Snapshot source changed during capture');
    if (fs.fstatSync(fd).size !== stat.size) throw new Error('Snapshot source changed during capture');
    return { bytes, executable: (stat.mode & 0o111) !== 0 };
  } finally {
    fs.closeSync(fd);
  }
};
const fileEntry = (root: string, relative: string, maxBytes = snapshotByteLimit, rejectHardlinks = false): RecursiveEntry => {
  // Validate the entire relative path before separating its parent and leaf.
  validatePath(root, relative);
  const { bytes, executable } = inDirectory(root, path.dirname(relative), () => readBoundedFile(path.basename(relative), maxBytes, rejectHardlinks));
  return { path: relative.split(path.sep).join('/'), executable, content: bytes.toString('base64') };
};

const walkFiles = (root: string, profilesOnly: boolean, skills: boolean, limits: SnapshotLimits, reviewReadability: boolean, selection: RecursiveSelection): string[] => {
  if (!sourceStat(path.dirname(root), path.basename(root)).isDirectory()) return [];
  const files: string[] = [];
  const pending = [''];
  let visited = 0;
  let pathBytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    inDirectory(root, relative, () => {
      // Synced roots are synced/<collection>/<skill>; collection names are opaque.
      const parts = relative.split(path.sep);
      const synced = selection.claudeSkills && parts[0].toLowerCase() === 'synced';
      const syncContainer = synced && parts.length < 3;
      const skillFolder = selection.claudeSkills && (synced
        ? parts.length === 3 : relative !== '' && parts.length === 1);
      const candidates: string[] = [];
      const visitEntry = (name: string): void => {
        const entry = path.join(relative, name);
        pathBytes += Buffer.byteLength(JSON.stringify(entry));
        requireWithinLimit('bytes', pathBytes, limits.maxBytes ?? snapshotByteLimit);
        const stat = fs.lstatSync(name);
        if (stat.isDirectory() && !profilesOnly) pending.push(entry);
        else if (stat.isFile()) {
          if (selection.claudeSkills && (!relative || syncContainer)) return;
          if (selection.markdownOnly && !name.endsWith('.md')) return;
          if (skills && !selection.claudeSkills && parts.length === 2 && parts[1] === 'agents' && name === 'openai.yaml') return;
          requireSingleLink(stat, selection.rejectHardlinks ?? false);
          if (reviewReadability) readableFileStat(name, selection.rejectHardlinks);
          files.push(entry);
        }
      };
      const directory = fs.opendirSync('.');
      try {
        let next;
        while ((next = directory.readSync()) !== null) {
          requireWithinLimit('entries', ++visited, limits.maxEntries ?? recursiveEntryLimit);
          const name = next.name;
          if (selection.claudeSkills && !relative) {
            const reserved = name.toLowerCase();
            // Legacy downloads shared the personal root; do not infer ownership
            // or read their manifest to decide which folders to capture.
            if (reserved === 'manifest.json') throw new SnapshotSourceTypeError('Legacy Claude skills manifest');
            if (name.startsWith('.') || reserved === 'anthropic-skills' || reserved.startsWith('anthropic-skills:')) continue;
          }
          // Sync containers hold collections and packages, not authoring files.
          // Keep their lifecycle state outside capture without reading manifests.
          if (syncContainer && claudeSyncBookkeeping.has(name.toLowerCase())) continue;
          if (profilesOnly && !/^.+\.config\.toml$/u.test(name)) continue;
          if (name === '.git' || name === '.DS_Store' || (skills && !relative && name === '.system')) continue;
          if (skillFolder) candidates.push(name);
          else visitEntry(name);
        }
      } finally { directory.closeSync(); }
      if (skillFolder) {
        // Enumerated spelling enforces exact SKILL.md even on case-insensitive
        // filesystems. Plugin markers exclude the complete candidate payload.
        if (candidates.some((name) => name.toLowerCase() === '.claude-plugin')
          || !candidates.includes('SKILL.md') || !fs.lstatSync('SKILL.md').isFile()) return;
        candidates.forEach(visitEntry);
      }
    });
  }
  return files.sort();
};
// Discovery must not turn a capture-time read failure into an optional skip.
const recursiveFiles = (root: string, profilesOnly = false, skills = false, limits: SnapshotLimits = {}, selection: RecursiveSelection = {}): string[] => (
  walkFiles(root, profilesOnly, skills, limits, false, selection)
);
const reviewRecursiveFiles = (root: string, profilesOnly = false, skills = false, limits: SnapshotLimits = {}, selection: RecursiveSelection = {}): string[] => (
  walkFiles(root, profilesOnly, skills, limits, true, selection)
);

const isReadableText = (bytes: Buffer): boolean => isUtf8(bytes) && !bytes.some((byte, index) => (
  (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
  || (byte === 194 && bytes[index + 1] >= 128 && bytes[index + 1] <= 159)
));
const entrySize = (entry: ReadableRecursiveEntry): number => {
  const serialized = JSON.stringify(entry, null, 2);
  // Entries are indented four spaces inside the archive.
  return Buffer.byteLength(serialized) + 4 * serialized.split('\n').length;
};
const encodeDirectoryEntry = (relative: string, executable: boolean, bytes: Buffer, maxBytes: number): {
  entry: ReadableRecursiveEntry; size: number;
} => {
  const name = relative.split(path.sep).join('/');
  if (!isReadableText(bytes)) {
    const entry: ReadableRecursiveEntry = { path: name, executable, encoding: 'base64', content: '' };
    const size = entrySize(entry) + 4 * Math.ceil(bytes.length / 3);
    requireWithinLimit('bytes', size, maxBytes);
    entry.content = bytes.toString('base64');
    return { entry, size };
  }
  const content: string[] = [];
  const entry: ReadableRecursiveEntry = { path: name, executable, encoding: 'utf8', content };
  let size = entrySize(entry);
  requireWithinLimit('bytes', size, maxBytes);
  let lines = 0;
  let lineSize = 2; // JSON string quotes.
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    lineSize += byte === 9 || byte === 10 || byte === 13 || byte === 34 || byte === 92 ? 2 : 1;
    if (byte === 10 || index === bytes.length - 1) {
      // Preflight all escaped lines before allocating the content array.
      size += lineSize + (lines++ === 0 ? 16 : 10);
      requireWithinLimit('bytes', size, maxBytes);
      lineSize = 2;
    }
  }
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    content.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return { entry, size };
};

const recursiveSnapshot = (root: string, profilesOnly = false, skills = false, limits: SnapshotLimits = {}, selection: RecursiveSelection = {}): string => {
  const files = recursiveFiles(root, profilesOnly, skills, limits, selection);
  if (files.length === 0) throw new Error('Snapshot source has no regular files');
  const maxBytes = limits.maxBytes ?? snapshotByteLimit;
  const stats = files.map((relative) => fileStat(root, relative, selection.rejectHardlinks));
  const entries: ReadableRecursiveEntry[] = files.map((relative, index) => ({
    path: relative.split(path.sep).join('/'), executable: (stats[index].mode & 0o111) !== 0, encoding: 'utf8', content: [],
  }));
  const serialize = (): string => `${JSON.stringify({ format: 'ballin-directory', version: 2, entries }, null, 2)}\n`;
  let usedBytes = Buffer.byteLength(serialize());
  requireWithinLimit('bytes', usedBytes, maxBytes);
  let predicted = usedBytes;
  for (const stat of stats) {
    // Every representation is at least as large as its raw file bytes.
    predicted += stat.size;
    requireWithinLimit('bytes', predicted, maxBytes);
  }
  files.forEach((relative, index) => {
    const placeholderBytes = entrySize(entries[index]);
    const available = maxBytes - usedBytes + placeholderBytes;
    const { bytes, executable } = inDirectory(root, path.dirname(relative), () => (
      readBoundedFile(path.basename(relative), available, selection.rejectHardlinks)
    ));
    const captured = encodeDirectoryEntry(relative, executable, bytes, available);
    entries[index] = captured.entry;
    usedBytes += captured.size - placeholderBytes;
  });
  const snapshot = serialize();
  requireWithinLimit('bytes', Buffer.byteLength(snapshot), maxBytes);
  return snapshot;
};

module.exports = { checkedPath, sourceStat, fileStat, fileEntry, readBoundedFile, recursiveFiles, reviewRecursiveFiles, recursiveSnapshot,
  snapshotByteLimit, recursiveEntryLimit, SnapshotLimitError, SnapshotCwdError, SnapshotSourceTypeError, requireWithinLimit, isReadableText, encodeDirectoryEntry };
export type { RecursiveEntry, ReadableRecursiveEntry, SnapshotLimits, RecursiveSelection };

if (require.main === module) {
  try {
    const limitIndex = process.argv.indexOf('--max-bytes', 4);
    const maxBytes = limitIndex < 0 ? snapshotByteLimit : Number(process.argv[limitIndex + 1]);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > snapshotByteLimit) throw new Error('Invalid snapshot limit');
    const rejectHardlinks = process.argv.includes('--reject-hardlinks');
    if (process.argv[3] === 'file') {
      validatePath(process.argv[2], process.argv[4]);
      const bytes = inDirectory(process.argv[2], path.dirname(process.argv[4]), () => readBoundedFile(path.basename(process.argv[4]), maxBytes, rejectHardlinks).bytes);
      process.stdout.write(bytes);
    } else {
      process.stdout.write(recursiveSnapshot(process.argv[2], process.argv[3] === 'profiles', process.argv[3] === 'skills', { maxBytes }, {
        markdownOnly: process.argv[3] === 'markdown', claudeSkills: process.argv[3] === 'claude-skills', rejectHardlinks,
      }));
    }
  } catch (error) {
    process.stderr.write(error instanceof SnapshotLimitError ? `${error.message}\n` : 'Unable to capture recursive snapshot.\n');
    process.exitCode = 1;
  }
}
