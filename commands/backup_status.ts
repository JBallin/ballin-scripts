const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const { repositoryCacheDirectory } = require('./backup_repository.ts') as {
  repositoryCacheDirectory: (root: string, destination: RepositoryDestination) => string;
};
import type { RepositoryDestination } from './backup_config.ts';

// Local bookkeeping only: never a snapshot, configuration leaf or remote receipt.
const lastSuccessFileName = '.last-success';
const privateEntry = (entry: string, directory: boolean): boolean => {
  const stat = fs.lstatSync(entry);
  return (directory ? stat.isDirectory() : stat.isFile())
    && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;
};
const readLastBackupSuccess = (
  root: string, destination: RepositoryDestination, now = Date.now(),
): string | null => {
  let descriptor: number | undefined;
  try {
    const directory = repositoryCacheDirectory(root, destination);
    if (!privateEntry(root, true) || !privateEntry(directory, true)) return null;
    if (!privateEntry(path.join(directory, lastSuccessFileName), false)) return null;
    descriptor = fs.openSync(path.join(directory, lastSuccessFileName), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size !== 25) return null;
    const buffer = Buffer.alloc(26);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, size).toString('utf8');
    const time = Date.parse(text.trim());
    return Number.isFinite(time) && time >= 0 && time <= now
      && `${new Date(time).toISOString()}\n` === text ? text.trim() : null;
  } catch { return null; } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Reading status never fails its caller. */ }
    }
  }
};
const recordLastBackupSuccess = (
  root: string, destination: RepositoryDestination, now = Date.now(),
): boolean => {
  let temporary: string | undefined;
  try {
    // Creation is advisory; existing required cache security has already run.
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
    if (!privateEntry(root, true)) return false;
    const directory = repositoryCacheDirectory(root, destination);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
    if (!privateEntry(directory, true)) return false;
    const file = path.join(directory, lastSuccessFileName);
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.uid !== process.getuid!())) return false;
    temporary = path.join(directory, `.last-success-${crypto.randomUUID()}`);
    fs.writeFileSync(temporary, `${new Date(now).toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; } finally {
    if (temporary) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* A completed replacement remains recorded. */ }
    }
  }
};
const lastBackupSuccessLine = (root: string, destination: RepositoryDestination): string => (
  `Last recorded successful backup on this installation: ${readLastBackupSuccess(root, destination) ?? 'unavailable'}`
);
const previousBackupSuccessLine = (root: string, destination: RepositoryDestination): string | null => {
  const previous = readLastBackupSuccess(root, destination);
  if (!previous) return null;
  const time = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).format(new Date(previous));
  return `Last successful backup: ${time}`;
};

module.exports = { lastSuccessFileName, readLastBackupSuccess, recordLastBackupSuccess, lastBackupSuccessLine, previousBackupSuccessLine };
