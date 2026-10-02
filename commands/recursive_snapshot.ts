const fs = require('fs');
const path = require('path');

type RecursiveEntry = { path: string; executable: boolean; content: string };

// Enumerate regular files without following symlinks. Metadata-only discovery
// uses this same traversal, so empty or generated-only sources stay absent.
const checkedPath = (root: string, relative: string): string => {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('Invalid snapshot path');
  if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Snapshot root changed');
  let current = root;
  for (const part of relative.split(path.sep).filter((part: string) => part && part !== '.')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      const error = new Error('Symlinked snapshot source') as NodeJS.ErrnoException;
      error.code = 'ELOOP';
      throw error;
    }
  }
  return current;
};

const fileEntry = (root: string, relative: string): RecursiveEntry => {
  const file = checkedPath(root, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot source is not a regular file');
    return {
      path: relative.split(path.sep).join('/'),
      executable: (stat.mode & 0o111) !== 0,
      content: fs.readFileSync(fd).toString('base64'),
    };
  } finally {
    fs.closeSync(fd);
  }
};

const recursiveFiles = (root: string, profilesOnly = false, skills = false): string[] => {
  checkedPath(root, '.');
  if (!fs.lstatSync(root).isDirectory()) return [];
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const name of fs.readdirSync(checkedPath(root, relative)).sort()) {
      if (profilesOnly && !/^.+\.config\.toml$/u.test(name)) continue;
      if (name === '.git' || name === '.DS_Store' || (skills && !relative && name === '.system')) continue;
      const entry = path.join(relative, name);
      const stat = fs.lstatSync(path.join(root, entry));
      if (stat.isDirectory() && !profilesOnly) visit(entry);
      else if (stat.isFile()) files.push(entry);
    }
  };
  visit('');
  return files.sort();
};

const recursiveSnapshot = (root: string, profilesOnly = false, skills = false): string => {
  const entries = recursiveFiles(root, profilesOnly, skills).map((relative) => fileEntry(root, relative));
  if (entries.length === 0) throw new Error('Snapshot source has no regular files');
  return `${JSON.stringify({ format: 'ballin-directory', version: 1, entries }, null, 2)}\n`;
};

module.exports = { checkedPath, fileEntry, recursiveFiles, recursiveSnapshot };
export type { RecursiveEntry };

if (require.main === module) {
  try {
    process.stdout.write(process.argv[3] === 'file'
      ? Buffer.from(fileEntry(process.argv[2], process.argv[4]).content, 'base64')
      : recursiveSnapshot(process.argv[2], process.argv[3] === 'profiles', process.argv[3] === 'skills'));
  } catch {
    process.stderr.write('Unable to capture recursive snapshot.\n');
    process.exitCode = 1;
  }
}
