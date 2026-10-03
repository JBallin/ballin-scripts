const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runCommand, makeTempFile, removeTempFile } = require('./commandHelpers.ts');
import type { AvailableSnapshotObservation } from './backup_snapshots.ts';

// Public npm 11.19.0 tarball, including its bundled runtime dependencies.
// Qualification evidence and limitations are recorded in docs/backup-collector-qualification.md.
const npmArtifactDigests = new Set([
  '5b18b54d55d52474a913ee469f117a2010452e42adaefa62c0078d5c2609a5d8',
  '8a05df487ac1c8e03d63f5b08e88028a5b453751db9887b0c508875eeba20148',
]);
const artifactDigest = (root: string): string => {
  const hash = crypto.createHash('sha256');
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort((a: string, b: string) => a.localeCompare(b, 'en'))) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        hash.update(path.relative(root, file)); hash.update('\0');
        hash.update(fs.readFileSync(file)); hash.update('\0');
      } else throw new Error('Unsupported tool artifact');
    }
  };
  visit(root);
  return hash.digest('hex');
};


const brewPrefixFiles: Record<string, string> = {
  'bin/brew': 'c9a27029eb72dab04f4595041f7670bb03b4cb467297abba817883afb23e0bf3',
  'Library/Homebrew/brew.sh': 'b00ebe84912f4171560be6f3c222477f05b8d1ea8586bd7d80128c10b631caaa',
  'Library/Homebrew/utils/os.sh': 'c83eacf7b72cfffac02b87973622bb5b66f6d6ca6e9d80d27b922e5dc0318fa6',
  'Library/Homebrew/help.sh': 'b794805694d185f3d5832c4833b14e68bd6fca08f22fe158b08be1159260ad70',
  'Library/Homebrew/formula_path.sh': '87c5c6c9e751769c5fa7a208fecb811c18405e52515d7ee7a893b95e0e815212',
};
const noEntry = (file: string): boolean => {
  try { fs.lstatSync(file); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
};
const readQualifiedBrewPrefix = (tool: string, env: NodeJS.ProcessEnv): string | undefined => {
  if (process.platform !== 'darwin' || !env.HOME) return undefined;
  try {
    const bin = fs.realpathSync(path.dirname(tool));
    // Alternate prefix/repository symlink layouts have not been qualified.
    if (fs.realpathSync(tool) !== path.join(bin, 'brew')) return undefined;
    const root = path.dirname(bin);
    for (const [name, expected] of Object.entries(brewPrefixFiles)) {
      const file = path.join(root, name);
      if (!fs.lstatSync(file).isFile() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) return undefined;
    }
    const userConfig = path.join(env.XDG_CONFIG_HOME || env.HOMEBREW_XDG_CONFIG_HOME || path.join(env.HOME, '.homebrew'), env.XDG_CONFIG_HOME || env.HOMEBREW_XDG_CONFIG_HOME ? 'homebrew/brew.env' : 'brew.env');
    if (![ '/etc/homebrew/brew.env', path.join(root, 'etc/homebrew/brew.env'), userConfig ].every(noEntry)) return undefined;
    if (Object.keys(env).some((key) => (key.startsWith('DYLD_') || key.startsWith('LD_')) && env[key])) return undefined;
    const result = runCommand('/bin/bash', ['-p', path.join(bin, 'brew'), '--prefix'], {
      env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOMEBREW_BREW_FILE: '', HOMEBREW_PATH: '', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
    });
    if (result.error || result.signal || result.status !== 0) throw new Error('Qualified discovery failed');
    return result.stdout.trim() || undefined;
  } catch { return undefined; }
};

type CollectorCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };
const qualifiedCollector = (source: AvailableSnapshotObservation): CollectorCommand | undefined => {
  const env = source.collector.env ?? process.env;
  if (process.platform !== 'darwin' || env.NODE_OPTIONS || env.NODE_PATH || Object.keys(env).some((key) => (key.startsWith('DYLD_') || key.startsWith('LD_')) && env[key])) return undefined;
  if (source.definition.name === 'bash_completions' && source.source.kind === 'directory') {
    return { command: '/bin/ls', args: [source.source.path as string], env: source.collector.env ?? process.env };
  }
  if (source.definition.name !== 'npm_global' || process.version !== 'v24.21.0') return undefined;
  // Do not execute shell wrappers; inherited code-loading controls were rejected above.
  try {
    const cli = fs.realpathSync(source.source.path);
    if (path.basename(cli) !== 'npm-cli.js' || path.basename(path.dirname(cli)) !== 'bin') return undefined;
    const root = path.dirname(path.dirname(cli));
    if (!npmArtifactDigests.has(artifactDigest(root))) return undefined;
    return {
      command: process.execPath,
      args: [cli, 'list', '-g', '--depth=0', '--update-notifier=false', '--timing=false'],
      env,
      cwd: source.collector.cwd,
    };
  } catch { return undefined; }
};
const captureQualifiedCollector = (source: AvailableSnapshotObservation): Buffer | undefined => {
  const command = qualifiedCollector(source);
  if (!command) return undefined;
  const file = makeTempFile('ballin-verify-collector-');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    const result = runCommand(command.command, command.args, {
      env: command.env, cwd: command.cwd, stdio: ['ignore', fd, 'pipe'],
    });
    if (result.error || result.signal || result.status !== 0) throw new Error('Qualified collector failed');
    // Snapshot transport saves raw stdout; stderr never becomes a diagnostic.
    return fs.readFileSync(file);
  } finally {
    try { fs.closeSync(fd); } finally { removeTempFile(file); }
  }
};
module.exports = { qualifiedCollector, captureQualifiedCollector, artifactDigest, readQualifiedBrewPrefix };
export type { CollectorCommand };
