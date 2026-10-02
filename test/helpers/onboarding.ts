const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fixtureState, installRepositoryFixture } = require('./repository.ts');
import type { FixtureState } from './repository.ts';

type Sandbox = {
  root: string; home: string; tools: string; bin: string; repo: string; remote: string;
  log: string; scratch: string; source: string; guard: string; expected: Map<string, string>; links: Map<string, string>;
};
const markerName = '.ballin-onboarding-sandbox.json';
const source = path.resolve(__dirname, '../..');
const systemTools = ['bash', 'cat', 'cmp', 'cp', 'ls', 'mkdir', 'mktemp', 'rm', 'tail'];
const existsWithoutFollowingLinks = (file: string): boolean => {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const validateRoot = (root: string): void => {
  const resolved = path.resolve(root);
  if (root !== resolved || !path.basename(root).startsWith('ballin-onboarding-')
    || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root
    || ![os.tmpdir(), '/tmp'].some((directory) => fs.realpathSync(path.dirname(root)) === fs.realpathSync(directory))) {
    throw new Error('Refusing an unverified onboarding sandbox root');
  }
  const marker = JSON.parse(fs.readFileSync(path.join(root, markerName), 'utf8'));
  if (fs.lstatSync(path.join(root, markerName)).isSymbolicLink()
    || marker.root !== root || marker.version !== 1) throw new Error('Invalid onboarding sandbox marker');
};
const validateSandbox = (sandbox: Sandbox): void => {
  validateRoot(sandbox.root);
  for (const directory of [sandbox.home, sandbox.tools, sandbox.bin, sandbox.scratch, sandbox.remote]) {
    if (fs.realpathSync(directory) !== directory) throw new Error('Sandbox directory was replaced');
  }
  if (existsWithoutFollowingLinks(sandbox.repo) && (fs.lstatSync(sandbox.repo).isSymbolicLink()
    || fs.realpathSync(sandbox.repo) !== sandbox.repo)) throw new Error('Sandbox checkout was replaced');
  const state = path.join(sandbox.remote, 'repository.json');
  if (existsWithoutFollowingLinks(state) && fs.lstatSync(state).isSymbolicLink()) throw new Error('Sandbox remote state was replaced');
  if (fs.readdirSync(sandbox.tools).sort().join(',') !== [...systemTools, 'node', 'git', 'gh', 'softwareupdate'].sort().join(',')
    || fs.readdirSync(sandbox.bin).some((name: string) => name !== 'ballin')) throw new Error('Unexpected sandbox command');
  for (const [file, contents] of sandbox.expected) {
    if (fs.readFileSync(file, 'utf8') !== contents || fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Sandbox safeguard was changed: ${path.basename(file)}`);
    }
    if (file !== sandbox.guard) fs.accessSync(file, fs.constants.X_OK);
  }
  for (const [file, expected] of sandbox.links) {
    fs.accessSync(file, fs.constants.X_OK);
    if (fs.realpathSync(file) !== fs.realpathSync(expected)) throw new Error(`Sandbox tool was changed: ${path.basename(file)}`);
  }
  const shim = path.join(sandbox.bin, 'ballin');
  if (existsWithoutFollowingLinks(shim) && (!fs.lstatSync(shim).isSymbolicLink()
    || fs.readlinkSync(shim) !== path.join(sandbox.repo, 'bin/ballin'))) throw new Error('Sandbox Ballin shim was changed');
};
const sandboxEnvironment = (sandbox: Sandbox): NodeJS.ProcessEnv => {
  validateSandbox(sandbox);
  return {
    HOME: sandbox.home, PATH: [sandbox.tools, sandbox.bin].join(path.delimiter),
    TMPDIR: sandbox.scratch, PWD: sandbox.home,
    GH_CONFIG_DIR: path.join(sandbox.home, '.config/gh'), XDG_CONFIG_HOME: path.join(sandbox.home, '.config'),
    BALLIN_NO_ANALYTICS: '1', BALLIN_QA_ROOT: sandbox.root,
    BALLIN_UNINSTALL_TEST_SYSTEM_ROOT: path.join(sandbox.root, 'system'),
    NODE_OPTIONS: `--require=${sandbox.guard}`,
  };
};
const resetRemote = (sandbox: Sandbox, existing = false): void => {
  validateSandbox(sandbox);
  const state: FixtureState = fixtureState();
  state.exists = existing;
  fs.writeFileSync(path.join(sandbox.remote, 'repository.json'), JSON.stringify(state));
};
const resetSandbox = (sandbox: Sandbox, mode: 'fresh' | 'create' | 'reconnect'): void => {
  validateSandbox(sandbox);
  if (mode === 'fresh') {
    fs.rmSync(sandbox.repo, { recursive: true, force: true });
    fs.rmSync(path.join(sandbox.bin, 'ballin'), { force: true });
  } else {
    const configPath = path.join(sandbox.repo, 'ballin.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const defaults = JSON.parse(fs.readFileSync(path.join(source, 'config/.defaultConfig.json'), 'utf8'));
    config.backup = defaults.backup;
    config.update.backup = defaults.update.backup;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    fs.rmSync(path.join(sandbox.repo, '.backup-cache'), { recursive: true, force: true });
  }
  resetRemote(sandbox, mode === 'reconnect');
};
const cleanupSandbox = (root: string): void => {
  validateRoot(root);
  const active = path.join(root, '.active');
  if (fs.existsSync(active)) {
    const pid = Number(fs.readFileSync(active, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid sandbox session marker');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      fs.rmSync(root, { recursive: true });
      return;
    }
    throw new Error('Sandbox session is still running; exit it before cleanup');
  }
  fs.rmSync(root, { recursive: true });
};
const createSandbox = (): Sandbox => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-onboarding-')));
  const sandbox: Sandbox = {
    root, source, home: path.join(root, 'home'), tools: path.join(root, 'tools'),
    bin: path.join(root, 'home/.local/bin'), repo: path.join(root, 'home/.ballin-scripts'),
    remote: path.join(root, 'remote'), log: path.join(root, 'commands.log'), scratch: path.join(root, 'tmp'),
    guard: path.join(root, 'guard.ts'), expected: new Map(), links: new Map(),
  };
  try {
    fs.writeFileSync(path.join(root, markerName), JSON.stringify({ version: 1, root }));
    [sandbox.home, sandbox.tools, sandbox.bin, sandbox.remote, sandbox.scratch].forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    for (const name of systemTools) {
      const target = ['/bin', '/usr/bin'].map((directory) => path.join(directory, name)).find((file) => fs.existsSync(file));
      if (!target) throw new Error(`Required system tool is unavailable: ${name}`);
      fs.accessSync(target, fs.constants.X_OK);
      fs.symlinkSync(target, path.join(sandbox.tools, name));
      sandbox.links.set(path.join(sandbox.tools, name), target);
    }
    fs.symlinkSync(process.execPath, path.join(sandbox.tools, 'node'));
    sandbox.links.set(path.join(sandbox.tools, 'node'), process.execPath);
    fs.copyFileSync(path.join(__dirname, 'onboarding_guard.ts'), sandbox.guard);
    const git = path.join(sandbox.tools, 'git');
    fs.writeFileSync(git, `#!${process.execPath}\nconst fs = require('fs');\nconst path = require('path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(sandbox.log)}, 'git:' + args.join(' ') + '\\n');\nconst exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);\nif (exact(['--version'])) process.stdout.write('git version onboarding fixture\\n');\nelse if (exact(['clone', 'https://github.com/JBallin/ballin-scripts.git', '.ballin-scripts']) && process.cwd() === ${JSON.stringify(sandbox.home)}) {\n  fs.mkdirSync(${JSON.stringify(sandbox.repo)}, { recursive: true });\n  for (const name of ['commands', 'config', 'bin', 'completions', 'package.json']) fs.cpSync(path.join(${JSON.stringify(source)}, name), path.join(${JSON.stringify(sandbox.repo)}, name), { recursive: true });\n} else if (exact(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) process.exitCode = 1;\nelse if (process.cwd() === ${JSON.stringify(sandbox.repo)} && [\n  ['fetch', 'origin', '+main:refs/remotes/origin/main'], ['checkout', 'main'], ['merge', 'origin/main'], ['stash', 'push', '--include-untracked']\n].some(exact)) {}\nelse { process.stderr.write('Unsupported sandbox Git operation\\n'); process.exitCode = 2; }\n`, { mode: 0o755 });
    installRepositoryFixture(sandbox.tools, path.join(sandbox.remote, 'repository.json'));
    const softwareUpdate = path.join(sandbox.tools, 'softwareupdate');
    fs.writeFileSync(softwareUpdate, `#!${process.execPath}\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (JSON.stringify(args) !== JSON.stringify(['-ia'])) { process.stderr.write('Unsupported sandbox softwareupdate operation\\n'); process.exitCode = 2; }\nelse { fs.appendFileSync(${JSON.stringify(sandbox.log)}, 'softwareupdate:-ia\\n'); process.stdout.write('Simulated macOS update; no system changes.\\n'); }\n`, { mode: 0o755 });
    for (const file of [git, path.join(sandbox.tools, 'gh'), softwareUpdate, sandbox.guard]) sandbox.expected.set(file, fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(path.join(sandbox.home, '.zshrc'), '# Harmless onboarding QA fixture\nexport BALLIN_QA_EXAMPLE=1\n');
    resetRemote(sandbox);
    return sandbox;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
};
const runSandbox = (sandbox: Sandbox, args: string[], input?: string) => spawnSync(
  args[0] === 'install' ? path.join(source, 'install.sh') : path.join(sandbox.bin, 'ballin'),
  args[0] === 'install' ? [] : args,
  { cwd: sandbox.home, env: sandboxEnvironment(sandbox), input, encoding: 'utf8', timeout: 15000 },
);

module.exports = { createSandbox, validateSandbox, sandboxEnvironment, resetSandbox, resetRemote, cleanupSandbox, runSandbox };
export type { Sandbox };
