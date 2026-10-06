const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { isUtf8 } = require('node:buffer') as typeof import('node:buffer');
const { configuredBackupDestination } = require('./backup_config.ts');
const { repositoryCacheDirectory } = require('./backup_cache.ts');
const { directorySnapshotFileNames } = require('./backup_snapshots.ts');
const { readDirectorySnapshot } = require('./directory_snapshot.ts');
const { inDirectory, snapshotByteLimit } = require('./recursive_snapshot.ts');
import type { DirectorySnapshot } from './directory_snapshot.ts';

const configByteLimit = 64 * 1024;
const privateEntry = (stat: import('node:fs').Stats): boolean => (
  stat.uid === process.getuid!() && (stat.mode & 0o077) === 0
);

// Ancestors are pinned without following symlinks. No repair or cache creation.
const readPinnedFile = (name: string, limit: number, privateFile: boolean): Buffer => {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1
      || (privateFile && !privateEntry(stat)) || stat.size > limit) throw new Error('Unusable completion state');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) break;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs) throw new Error('Completion state changed');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
};
const readLocalFile = (file: string, limit: number): Buffer => inDirectory(
  path.dirname(file), '.', () => readPinnedFile(path.basename(file), limit, false),
);

const completionMemberPaths = (bundle: string, repoRoot = path.join(__dirname, '..'), configPath = path.join(repoRoot, 'ballin.config.json')): string[] => {
  try {
    if (!directorySnapshotFileNames.has(bundle) || !bundle.endsWith('.bundle.json')) return [];
    const config = readLocalFile(configPath, configByteLimit);
    if (!isUtf8(config)) return [];
    const destination = configuredBackupDestination(JSON.parse(config.toString('utf8')));
    if (destination.kind !== 'repository') return [];
    const root = path.join(repoRoot, '.backup-cache');
    const directory = repositoryCacheDirectory(root, destination.repository);
    const bytes: Buffer = inDirectory(root, '.', () => {
      if (!privateEntry(fs.statSync('.'))) throw new Error('Unsafe cache root');
      const selected = fs.lstatSync(path.basename(directory));
      if (!selected.isDirectory() || !privateEntry(selected)) throw new Error('Unsafe destination cache');
      process.chdir(path.basename(directory));
      const pinned = fs.statSync('.');
      if (!privateEntry(pinned) || process.cwd() !== directory || selected.dev !== pinned.dev || selected.ino !== pinned.ino) throw new Error('Cache changed');
      return readPinnedFile(bundle, snapshotByteLimit, true);
    });
    const archive: DirectorySnapshot = readDirectorySnapshot(bytes);
    const names = archive.entries.map((entry) => entry.path);
    // Newline protocol cannot represent control characters; return no partial list.
    if (names.some((name) => /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name))) return [];
    return names;
  } catch { return []; }
};

module.exports = { completionMemberPaths, configByteLimit };

if (require.main === module) {
  const members = process.argv.length === 3 ? completionMemberPaths(
    process.argv[2], process.env.BALLIN_TEST_REPO_DIR || path.join(__dirname, '..'), process.env.BALLIN_TEST_CONFIG_PATH,
  ) : [];
  if (members.length) process.stdout.write(`${members.join('\n')}\n`);
}
