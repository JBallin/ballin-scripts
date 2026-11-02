const fs = require('fs');
const { randomUUID } = require('crypto');

// Stage beside the resolved destination so rename commits a complete file on one filesystem.
const writeConfigFile = (configPath: string, contents: string): void => {
  let destination = configPath;
  let mode = 0o600;
  try {
    destination = fs.realpathSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing config can be recreated, but do not replace a dangling symlink.
    let entry;
    try { entry = fs.lstatSync(configPath); } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
    }
    if (entry) throw error;
  }
  if (fs.existsSync(destination)) {
    const stat = fs.statSync(destination);
    if (!stat.isFile()) throw Object.assign(new Error('Config is not a regular file'), { code: 'EISDIR' });
    // Atomic replacement cannot update every alias of a hard-linked file.
    if (stat.nlink !== 1) throw Object.assign(new Error('Config has multiple hard links'), { code: 'EMLINK' });
    fs.accessSync(destination, fs.constants.W_OK);
    mode = stat.mode & 0o777;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, contents, 'utf8');
      fs.fchmodSync(fd, mode);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally {
    if (created) fs.rmSync(temporary, { force: true });
  }
};

module.exports = { writeConfigFile };
