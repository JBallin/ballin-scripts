const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandExists, runCommand, requireUninterrupted, rethrowInterruption } = require('./commandHelpers.ts');

type NvmInstallation = { directory: string; source: string; completion: string; method: 'official' | 'homebrew' };
const readableFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.R_OK), true); } catch { return false; }
};
const safeDirectory = (directory: string): boolean => path.isAbsolute(directory) && !/[:\r\n\0]/u.test(directory);

// HOME/NVM_DIR isolation contains ordinary NVM bookkeeping, not arbitrary shell
// code. Trust every traversed component before executing an existing source.
const homebrewSourcePrefix = (file: string): string | undefined => {
  try {
    const match = fs.realpathSync(file).match(/^(.*)\/(?:Cellar\/nvm\/[^/]+|opt\/nvm)\/libexec\/nvm\.sh$/u);
    if (!match) return undefined;
    const prefix = match[1];
    return [path.join(prefix, 'Library/Homebrew/brew.sh'), path.join(prefix, 'Homebrew/Library/Homebrew/brew.sh')].some(readableFile) ? prefix : undefined;
  } catch { return undefined; }
};

const trustedNvmPath = (file: string, kind: 'file' | 'directory' | 'entry', homebrewPrefix?: string): boolean => {
  if (!safeDirectory(file) || !process.getuid) return false;
  const uid = process.getuid();
  let pending = file.split('/').filter(Boolean);
  let current = '/';
  let links = 0;
  try {
    while (true) {
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        return kind === 'entry' && !pending.length && (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (stat.uid !== 0 && stat.uid !== uid) return false;
      if (!stat.isSymbolicLink()) {
        // A sticky directory protects each trusted owner's entry from peers.
        // Standard macOS Homebrew directories trust the privileged admin group.
        // This exception never applies to files, world-write, or the NVM tree.
        const homebrewAdmin = process.platform === 'darwin' && stat.isDirectory() && stat.gid === 80
          && homebrewPrefix && (current === homebrewPrefix || current.startsWith(`${homebrewPrefix}/`))
          && !(stat.mode & 0o002);
        if ((stat.mode & 0o022) && !homebrewAdmin && !(stat.isDirectory() && (stat.mode & 0o1000))) return false;
      }
      if (process.platform === 'darwin') {
        const acl = runCommand('/bin/ls', ['-lde', current], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
        requireUninterrupted(acl);
        if (acl.status !== 0 || !acl.stdout || /^\s*\d+:.* allow .*\b(?:write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)\b/mu.test(acl.stdout)) return false;
      }
      if (stat.isSymbolicLink()) {
        if (++links > 40) return false;
        const target = fs.readlinkSync(current);
        pending = [...target.split('/').filter(Boolean), ...pending];
        current = path.isAbsolute(target) ? '/' : path.dirname(current);
        continue;
      }
      if (!pending.length) return kind === 'file' ? stat.isFile() : kind === 'directory' ? stat.isDirectory() : stat.isFile() || stat.isDirectory();
      if (!stat.isDirectory()) return false;
      const next = pending.shift()!;
      current = next === '..' ? path.dirname(current) : next === '.' ? current : path.join(current, next);
    }
  } catch (error) { rethrowInterruption(error); return false; }
};

const trustedNvmSource = (file: string): boolean => trustedNvmPath(file, 'file', homebrewSourcePrefix(file));

// NVM may execute an already-installed Node during `nvm install`, so validate
// its working tree before invoking it, not just the script or final executable.
// Report the first failing path so users can repair it without searching.
type NvmTrustFailure = { kind: 'directory' | 'entry' | 'link' | 'acl' | 'scan'; path: string };
const untrustedNvmEntry = (directory: string, source: string): NvmTrustFailure | null => {
  if (!trustedNvmPath(directory, 'directory')) return { kind: 'directory', path: directory };
  const prefix = homebrewSourcePrefix(source);
  const find = (args: string[]): string[] | null => {
    const result = runCommand('/usr/bin/find', [...args, '-print0'], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    requireUninterrupted(result);
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.split('\0').filter(Boolean) : null;
  };
  const unsafe = find(['-L', directory, '(', '(', '!', '-user', String(process.getuid!()), '-a', '!', '-user', '0', ')',
    '-o', '(', '!', '-type', 'l', '-a', '(', '-perm', '-0020', '-o', '-perm', '-0002', ')', ')', ')']);
  if (unsafe === null) return { kind: 'scan', path: directory };
  if (unsafe.length) return { kind: 'entry', path: unsafe[0] };
  const inspectLinks = (tree: string, depth = 0): NvmTrustFailure | null => {
    if (depth > 40) return { kind: 'link', path: tree };
    // Follow this root only, then inspect and recurse through each nested link.
    const links = find(['-H', tree, '-type', 'l']);
    if (links === null) return { kind: 'scan', path: tree };
    for (const link of links) {
      const sourceLink = link === path.join(directory, 'nvm.sh') || link === path.join(directory, 'nvm-exec');
      if (!trustedNvmPath(link, 'entry', sourceLink ? prefix : undefined)) return { kind: 'link', path: link };
      if (fs.existsSync(link) && fs.statSync(link).isDirectory()) {
        const failure = inspectLinks(link, depth + 1);
        if (failure) return failure;
      }
    }
    return null;
  };
  const linkFailure = inspectLinks(directory);
  if (linkFailure) return linkFailure;
  if (process.platform === 'darwin') {
    const acls = find(['-L', directory, '-acl']);
    if (acls === null) return { kind: 'scan', path: directory };
    for (const entry of acls) if (!trustedNvmPath(entry, 'entry')) return { kind: 'acl', path: entry };
  }
  return null;
};
const trustedNvmDirectory = (directory: string, source: string): boolean => untrustedNvmEntry(directory, source) === null;

// Resolve the formula's libexec directly. Its outer nvm.sh wrapper can mkdir/link
// even with --no-use, so it must never be executed during discovery.
const discoverNvm = (env: NodeJS.ProcessEnv = process.env): NvmInstallation | null => {
  const home = env.HOME;
  const directories = [env.NVM_DIR, env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'nvm'), home && path.join(home, '.nvm')].filter(Boolean) as string[];
  for (const directory of directories) {
    if (!safeDirectory(directory)) continue;
    const file = `${directory}/nvm.sh`;
    if (!readableFile(file)) continue;
    if (!trustedNvmSource(file)) return null;
    let source = fs.realpathSync(file);
    if (source.includes('/Cellar/nvm/')) {
      const stable = path.join(source.split('/Cellar/nvm/')[0], 'opt/nvm/libexec/nvm.sh');
      if (readableFile(stable) && trustedNvmSource(stable) && fs.realpathSync(stable) === source) source = stable;
    }
    // A standard brew symlink leads to libexec, not the mutating formula wrapper.
    if (/\/nvm(?:\/[^/]+)?\/libexec\/nvm\.sh$/u.test(source)) {
      return { directory, source, completion: path.join(path.dirname(path.dirname(source)), 'etc/bash_completion.d/nvm'), method: 'homebrew' };
    }
    const text = fs.readFileSync(source, 'utf8');
    if (text.includes('libexec/nvm.sh') && !text.includes('nvm_process_parameters')) continue;
    return { directory, source, completion: path.join(directory, 'bash_completion'), method: 'official' };
  }
  if (env.BALLIN_EXPERIMENT_INSTALL_OWNER === 'direct' || !commandExists('brew', { env })) return null;
  const result = runCommand('brew', ['--prefix'], { env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' } });
  requireUninterrupted(result);
  const prefix = result.stdout?.trimEnd();
  if (result.status !== 0 || !prefix || !safeDirectory(prefix)) return null;
  const source = path.join(prefix, 'opt/nvm/libexec/nvm.sh');
  const directory = env.NVM_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'nvm') : home && path.join(home, '.nvm'));
  if (!directory || !safeDirectory(directory) || !readableFile(source) || !trustedNvmSource(source)) return null;
  return { directory, source, completion: path.join(prefix, 'opt/nvm/etc/bash_completion.d/nvm'), method: 'homebrew' };
};

const followsLtsAlias = (directory: string): boolean => {
  let alias = 'default';
  const visited = new Set<string>();
  for (let depth = 0; depth < 40; depth += 1) {
    if (alias === 'lts/*') return true;
    if ((!/^[A-Za-z0-9_.-]+$/u.test(alias) || ['.', '..'].includes(alias)) || visited.has(alias)) return false;
    visited.add(alias);
    try {
      const file = path.join(directory, 'alias', alias);
      if (fs.lstatSync(file).isSymbolicLink() || !readableFile(file)) return false;
      alias = fs.readFileSync(file, 'utf8').trim();
    } catch { return false; }
  }
  return false;
};

// NVM's queries can maintain alias metadata. Probe a disposable model of its
// aliases/installed versions, with a temporary HOME and NVM_DIR, never the user's
// writable NVM tree. No Node executable or personal startup file is executed.
const inspectNvm = (env: NodeJS.ProcessEnv = process.env): { installation: NvmInstallation | null; loadable: boolean; followsLts: boolean } => {
  let installation: NvmInstallation | null;
  try { installation = discoverNvm(env); } catch (error) {
    rethrowInterruption(error);
    return { installation: null, loadable: false, followsLts: false };
  }
  if (!installation || !trustedNvmSource(installation.source)) return { installation, loadable: false, followsLts: false };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-nvm-probe-'));
  try {
    const directory = path.join(root, 'nvm');
    fs.mkdirSync(directory);
    const copyAliases = (source: string, target: string, depth = 0): void => {
      if (depth > 2 || !fs.existsSync(source)) return;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(source).slice(0, 1000)) copyAliases(path.join(source, name), path.join(target, name), depth + 1);
      } else if (stat.isFile() && stat.size <= 4096) fs.copyFileSync(source, target);
    };
    copyAliases(path.join(installation.directory, 'alias'), path.join(directory, 'alias'));
    const versions = path.join(installation.directory, 'versions/node');
    if (fs.existsSync(versions)) {
      for (const version of fs.readdirSync(versions)) {
        if (!/^v\d+\.\d+\.\d+$/u.test(version) || !readableFile(path.join(versions, version, 'bin/node'))) continue;
        const bin = path.join(directory, 'versions/node', version, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
      }
    }
    const result = runCommand('/bin/bash', ['--noprofile', '--norc', '-c',
      '. "$1" --no-use >/dev/null && declare -F nvm >/dev/null || exit 1; printf "loadable\\n"; nvm version default', 'ballin-nvm-probe', installation.source], {
      env: { PATH: env.PATH, HOME: root, NVM_DIR: directory, TMPDIR: root, BASH_ENV: '', ENV: '', NVM_NO_COLORS: '1' },
    });
    requireUninterrupted(result);
    const loadable = result.stdout?.startsWith('loadable\n') ?? false;
    return { installation, loadable, followsLts: loadable && followsLtsAlias(installation.directory)
      && result.status === 0 && /^v\d+\.\d+\.\d+$/mu.test(result.stdout) };
  } catch (error) {
    rethrowInterruption(error);
    return { installation, loadable: false, followsLts: false };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

module.exports = { discoverNvm, inspectNvm, followsLtsAlias, trustedNvmSource, trustedNvmDirectory, untrustedNvmEntry };
export type { NvmInstallation, NvmTrustFailure };
