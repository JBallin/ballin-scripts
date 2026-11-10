const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { createHash } = require('crypto') as typeof import('crypto');
const { writeConfigFile } = require('../config/writeConfigFile.ts');
const { writeStdoutLine, writeStderrLine } = require('./commandHelpers.ts');
const { isHomebrewInstallation, stateDirectory } = require('./installation.ts');
type BackupScope = typeof import('./backup_scope.json');

// Local notification bookkeeping, never consent, a backup snapshot or cache state.
const packageScopeReceiptName = '.backup-scope-notice';
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const packageScopeFingerprint = (scope: BackupScope): string => createHash('sha256').update(canonical({
  ...scope,
  sources: scope.sources.map(canonical).sort(),
  portableUpdateKeys: [...scope.portableUpdateKeys].sort(),
  recursive: {
    ...scope.recursive,
    excludedNames: [...scope.recursive.excludedNames].sort(),
    claudeSyncBookkeeping: [...scope.recursive.claudeSyncBookkeeping].sort(),
    claudeExcludedRoots: [...scope.recursive.claudeExcludedRoots].sort(),
  },
})).digest('hex');

const notifyPackageBackupScope = (
  includeSensitive: boolean, repoDir = path.join(__dirname, '..'),
): void => {
  if (!isHomebrewInstallation(repoDir)) return;
  const directory = stateDirectory(repoDir);
  const file = path.join(directory, packageScopeReceiptName);
  let previous: string | undefined;
  let unavailable = false;
  let fingerprint: string;
  try {
    fingerprint = packageScopeFingerprint(JSON.parse(fs.readFileSync(path.join(repoDir, 'commands/backup_scope.json'), 'utf8')));
  } catch {
    writeStderrLine('Unable to inspect the package backup-source catalog; scope changes could not be compared. Review: getballin.com/docs/backup-sources.html');
    return;
  }
  try {
    const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (parent && (!parent.isDirectory() || parent.uid !== process.getuid!())) throw new Error('Invalid state directory');
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid!() || entry.size !== 68) throw new Error('Invalid scope receipt');
      const text = fs.readFileSync(file, 'utf8');
      if (!/^v1:[a-f0-9]{64}\n$/u.test(text)) throw new Error('Invalid scope receipt');
      previous = text.slice(3, -1);
    }
  } catch { unavailable = true; }
  if (previous === fingerprint) return;
  writeStdoutLine(previous
    ? 'Supported backup sources or collection scope changed since the last package backup-scope notice.'
    : unavailable ? 'Unable to compare backup scope with the previous package notice.'
      : 'First backup-scope notice for this package installation.');
  if (includeSensitive) writeStdoutLine('Your sensitive-source opt-in remains enabled across updates and covers current and future supported sources.');
  writeStdoutLine('Review current backup sources and collection scope: getballin.com/docs/backup-sources.html');
  try {
    const directoryEntry = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!directoryEntry) fs.mkdirSync(directory, { mode: 0o700 });
    else if (!directoryEntry.isDirectory() || directoryEntry.uid !== process.getuid!()) throw new Error('Invalid state directory');
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid!())) throw new Error('Invalid scope receipt');
    writeConfigFile(file, `v1:${fingerprint}\n`);
  } catch {
    writeStderrLine('Unable to record the local backup-scope notice. Backup will continue; this notice may repeat.');
  }
};
module.exports = { packageScopeReceiptName, packageScopeFingerprint, notifyPackageBackupScope };
