const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandExists, runCommand, requireUninterrupted, rethrowInterruption } = require('./commandHelpers.ts');

type NvmInstallation = { directory: string; source: string; completion: string; method: 'official' | 'homebrew' };
const readableFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.R_OK), true); } catch { return false; }
};
const safeDirectory = (directory: string): boolean => path.isAbsolute(directory) && !/[:\r\n\0]/u.test(directory);

// Resolve the formula's libexec directly. Its outer nvm.sh wrapper can mkdir/link
// even with --no-use, so it must never be executed during discovery.
const discoverNvm = (env: NodeJS.ProcessEnv = process.env): NvmInstallation | null => {
  const home = env.HOME;
  const directories = [env.NVM_DIR, env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'nvm'), home && path.join(home, '.nvm')].filter(Boolean) as string[];
  for (const directory of directories) {
    if (!safeDirectory(directory)) continue;
    const file = path.join(directory, 'nvm.sh');
    if (!readableFile(file)) continue;
    let source = fs.realpathSync(file);
    if (source.includes('/Cellar/nvm/')) {
      const stable = path.join(source.split('/Cellar/nvm/')[0], 'opt/nvm/libexec/nvm.sh');
      if (readableFile(stable) && fs.realpathSync(stable) === source) source = stable;
    }
    // A standard brew symlink leads to libexec, not the mutating formula wrapper.
    if (/\/nvm(?:\/[^/]+)?\/libexec\/nvm\.sh$/u.test(source)) {
      return { directory, source, completion: path.join(path.dirname(path.dirname(source)), 'etc/bash_completion.d/nvm'), method: 'homebrew' };
    }
    const text = fs.readFileSync(source, 'utf8');
    if (text.includes('libexec/nvm.sh') && !text.includes('nvm_process_parameters')) continue;
    return { directory, source, completion: path.join(directory, 'bash_completion'), method: 'official' };
  }
  if (!commandExists('brew', { env })) return null;
  const result = runCommand('brew', ['--prefix'], { env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' } });
  requireUninterrupted(result);
  const prefix = result.stdout?.trimEnd();
  if (result.status !== 0 || !prefix || !safeDirectory(prefix)) return null;
  const source = path.join(prefix, 'opt/nvm/libexec/nvm.sh');
  const directory = env.NVM_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'nvm') : home && path.join(home, '.nvm'));
  if (!directory || !safeDirectory(directory) || !readableFile(source)) return null;
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
  if (!installation) return { installation, loadable: false, followsLts: false };
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

module.exports = { discoverNvm, inspectNvm, followsLtsAlias };
export type { NvmInstallation };
