// Narrow optional shellenv append, not a shell-profile migration tool.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
function inspect(brew, env = process.env) {
  const shell = path.basename(env.SHELL || '');
  if (!['bash', 'zsh'].includes(shell)) throw Error('Unsupported login shell.');
  const home = env.HOME;
  const directory = shell === 'zsh' ? env.ZDOTDIR || home : home;
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || /[\r\n]/.test(directory + brew)) throw Error('Unsafe startup directory.');
  const parents = [];
  let parent = directory;
  while (parent !== path.dirname(parent)) {
    const s = fs.lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022) || (s.uid !== process.getuid() && s.uid !== 0)) throw Error('Unsafe startup parent.');
    parents.push({ path: parent, dev: s.dev, ino: s.ino });
    parent = path.dirname(parent);
  }
  if (shell === 'bash' && ['.bash_login', '.profile'].some(name => fs.existsSync(path.join(directory, name)))) throw Error('Existing alternate Bash startup file requires manual review.');
  const file = path.join(directory, shell === 'zsh' ? '.zprofile' : '.bash_profile');
  let stat = null, text = '';
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o022)) throw Error('Unsafe startup file.');
    const bytes = fs.readFileSync(file);
    text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text))) throw Error('Startup file is not valid UTF-8; review manually.');
    stat = { dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const line = `eval "$( ${quote(brew)} shellenv ${shell} )"`;
  if (/brew|HOMEBREW|\/opt\/homebrew/.test(text)) throw Error('Existing Homebrew startup configuration requires manual review.');
  const next = `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n# Homebrew activation (Ballin experiment)\n${line}\n`;
  const syntax = cp.spawnSync(`/bin/${shell}`, ['-n'], { input: next, env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' });
  if (syntax.status !== 0) throw Error('Startup file syntax could not be verified.');
  return { file, shell, parents, stat, hash: crypto.createHash('sha256').update(text).digest('hex'), line, next };
}
function apply(brew, expected, env = process.env) {
  const current = inspect(brew, env);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw Error('Startup file changed after review.');
  const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
    (current.stat ? fs.constants.O_APPEND : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(current.file, flags, 0o600);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (current.stat && (s.ino !== current.stat.ino || s.dev !== current.stat.dev || s.size !== current.stat.size || s.mtimeMs !== current.stat.mtimeMs))) throw Error('Startup file changed before append.');
    const originalLength = current.stat ? current.stat.size : 0;
    fs.writeFileSync(fd, Buffer.from(current.next).subarray(originalLength));
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  try {
    const [mode, brew, snapshot] = process.argv.slice(2);
    if (mode === 'inspect') process.stdout.write(JSON.stringify(inspect(brew)));
    else if (mode === 'apply') apply(brew, JSON.parse(fs.readFileSync(snapshot, 'utf8')));
    else throw Error('Use inspect or apply.');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { inspect, apply };
