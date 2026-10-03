const fs = require('fs');
const path = require('path');

type RecursiveEntry = { path: string; executable: boolean; content: string };
type SnapshotLimits = { maxBytes?: number; maxEntries?: number };
const snapshotByteLimit = 16 * 1024 * 1024;
const recursiveEntryLimit = 8192;
class SnapshotLimitError extends Error {
  constructor(kind: 'bytes' | 'entries', actual: number, limit: number) {
    super(`Snapshot ${kind} limit exceeded (${actual} > ${limit}).`);
  }
}
class SnapshotCwdError extends Error {}
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

const readableFileStat = (name: string): import('fs').Stats => {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot source is not a regular file');
    return stat;
  } finally { fs.closeSync(fd); }
};
const fileStat = (root: string, relative: string): import('fs').Stats => {
  validatePath(root, relative);
  return inDirectory(root, path.dirname(relative), () => readableFileStat(path.basename(relative)));
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

const readBoundedFile = (file: string, maxBytes = snapshotByteLimit): { bytes: Buffer; executable: boolean } => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot source is not a regular file');
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
const fileEntry = (root: string, relative: string, maxBytes = snapshotByteLimit): RecursiveEntry => {
  // Validate the entire relative path before separating its parent and leaf.
  validatePath(root, relative);
  const { bytes, executable } = inDirectory(root, path.dirname(relative), () => readBoundedFile(path.basename(relative), maxBytes));
  return { path: relative.split(path.sep).join('/'), executable, content: bytes.toString('base64') };
};

const recursiveFiles = (root: string, profilesOnly = false, skills = false, limits: SnapshotLimits = {}): string[] => {
  if (!sourceStat(path.dirname(root), path.basename(root)).isDirectory()) return [];
  const files: string[] = [];
  const pending = [''];
  let visited = 0;
  let pathBytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    inDirectory(root, relative, () => {
      const directory = fs.opendirSync('.');
      try {
        let next;
        while ((next = directory.readSync()) !== null) {
          requireWithinLimit('entries', ++visited, limits.maxEntries ?? recursiveEntryLimit);
          const name = next.name;
          if (profilesOnly && !/^.+\.config\.toml$/u.test(name)) continue;
          if (name === '.git' || name === '.DS_Store' || (skills && !relative && name === '.system')) continue;
          const entry = path.join(relative, name);
          pathBytes += Buffer.byteLength(JSON.stringify(entry));
          requireWithinLimit('bytes', pathBytes, limits.maxBytes ?? snapshotByteLimit);
          const stat = fs.lstatSync(name);
          if (stat.isDirectory() && !profilesOnly) pending.push(entry);
          else if (stat.isFile()) { readableFileStat(name); files.push(entry); }
        }
      } finally { directory.closeSync(); }
    });
  }
  return files.sort();
};

const recursiveSnapshot = (root: string, profilesOnly = false, skills = false, limits: SnapshotLimits = {}): string => {
  const files = recursiveFiles(root, profilesOnly, skills, limits);
  if (files.length === 0) throw new Error('Snapshot source has no regular files');
  const maxBytes = limits.maxBytes ?? snapshotByteLimit;
  const stats = files.map((relative) => fileStat(root, relative));
  const entries = files.map((relative, index) => ({ path: relative.split(path.sep).join('/'), executable: (stats[index].mode & 0o111) !== 0, content: '' }));
  const serialize = (): string => `${JSON.stringify({ format: 'ballin-directory', version: 1, entries }, null, 2)}\n`;
  let metadataBytes = Buffer.byteLength('{\n  "format": "ballin-directory",\n  "version": 1,\n  "entries": [\n\n  ]\n}\n');
  entries.forEach((entry, index) => {
    // Each entry has five lines, indented four more spaces by the archive.
    metadataBytes += Buffer.byteLength(JSON.stringify(entry, null, 2)) + 20 + (index ? 2 : 0);
    requireWithinLimit('bytes', metadataBytes, maxBytes);
  });
  let predicted = metadataBytes;
  for (const stat of stats) {
    predicted += 4 * Math.ceil(stat.size / 3);
    requireWithinLimit('bytes', predicted, maxBytes);
  }
  let remaining = maxBytes - metadataBytes;
  files.forEach((relative, index) => {
    entries[index] = fileEntry(root, relative, 3 * Math.floor(remaining / 4));
    remaining -= entries[index].content.length;
  });
  const snapshot = serialize();
  requireWithinLimit('bytes', Buffer.byteLength(snapshot), maxBytes);
  return snapshot;
};

module.exports = { checkedPath, sourceStat, fileStat, fileEntry, readBoundedFile, recursiveFiles, recursiveSnapshot,
  snapshotByteLimit, recursiveEntryLimit, SnapshotLimitError, SnapshotCwdError, requireWithinLimit };
export type { RecursiveEntry, SnapshotLimits };

if (require.main === module) {
  try {
    const limitIndex = process.argv.indexOf('--max-bytes', 4);
    const maxBytes = limitIndex < 0 ? snapshotByteLimit : Number(process.argv[limitIndex + 1]);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > snapshotByteLimit) throw new Error('Invalid snapshot limit');
    if (process.argv[3] === 'file') {
      validatePath(process.argv[2], process.argv[4]);
      const bytes = inDirectory(process.argv[2], path.dirname(process.argv[4]), () => readBoundedFile(path.basename(process.argv[4]), maxBytes).bytes);
      process.stdout.write(bytes);
    } else {
      process.stdout.write(recursiveSnapshot(process.argv[2], process.argv[3] === 'profiles', process.argv[3] === 'skills', { maxBytes }));
    }
  } catch (error) {
    process.stderr.write(error instanceof SnapshotLimitError ? `${error.message}\n` : 'Unable to capture recursive snapshot.\n');
    process.exitCode = 1;
  }
}
