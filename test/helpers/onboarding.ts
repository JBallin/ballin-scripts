const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { processIsAlive } = require('./process_liveness.ts');
const { activeScenario, scenarioPath } = require('./sandbox_scenarios.ts');
const { fixtureState, installRepositoryFixture } = require('./repository.ts');
import type { FixtureState } from './repository.ts';

type Sandbox = {
  root: string; home: string; tools: string; bin: string; repo: string; remote: string;
  log: string; scratch: string; source: string; guard: string; expected: Map<string, string>; links: Map<string, string>;
};
const markerName = '.ballin-onboarding-sandbox.json';
const source = path.resolve(__dirname, '../..');
const systemTools = ['bash', 'cat', 'cmp', 'cp', 'ls', 'mkdir', 'mktemp', 'rm', 'tail'];
const sandboxCommandTimeout = 120000;
const sandboxSuiteTimeout = 300000;
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
const recordSession = (sandbox: Sandbox, groups: number[], launchPending = false): void => {
  validateRoot(sandbox.root);
  const active = path.join(sandbox.root, '.active');
  const staging = `${active}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staging, JSON.stringify({ parent: process.pid, groups, launchPending }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, active);
  } finally { fs.rmSync(staging, { force: true }); }
};
const validateSandbox = (sandbox: Sandbox): void => {
  validateRoot(sandbox.root);
  activeScenario(sandbox);
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
    NODE_OPTIONS: `--require=${JSON.stringify(sandbox.guard)}`,
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
  fs.writeFileSync(scenarioPath(sandbox), JSON.stringify({ name: 'none' }));
  fs.rmSync(path.join(sandbox.root, 'update-stage.ready'), { force: true });
};
const cleanupSandbox = (root: string): void => {
  validateRoot(root);
  const active = path.join(root, '.active');
  if (existsWithoutFollowingLinks(active)) {
    if (!fs.lstatSync(active).isFile()) throw new Error('Invalid sandbox session marker');
    const session = JSON.parse(fs.readFileSync(active, 'utf8'));
    const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && Number(pid) > 0 && Number(pid) <= 2147483647;
    if (!validPid(session.parent) || !Array.isArray(session.groups) || !session.groups.every(validPid)
      || typeof session.launchPending !== 'boolean') throw new Error('Invalid sandbox session marker');
    if ([session.parent, ...session.groups.map((group: number) => -group)].some(processIsAlive)) {
      throw new Error('Sandbox session or child process group is still running; stop it before cleanup');
    }
    if (session.launchPending) throw new Error('Sandbox launch state is ambiguous; cleanup cannot verify child shutdown');
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
    fs.writeFileSync(scenarioPath(sandbox), JSON.stringify({ name: 'none' }));
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
    fs.writeFileSync(git, `#!/usr/bin/env node\nconst fs = require('fs');\nconst path = require('path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(sandbox.log)}, 'git:' + args.join(' ') + '\\n');\nconst exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);\nif (exact(['--version'])) process.stdout.write('git version onboarding fixture\\n');\nelse if (exact(['clone', 'https://github.com/JBallin/ballin-scripts.git', '.ballin-scripts']) && process.cwd() === ${JSON.stringify(sandbox.home)}) {\n  fs.mkdirSync(${JSON.stringify(sandbox.repo)}, { recursive: true });\n  for (const name of ['commands', 'config', 'bin', 'completions', 'package.json']) fs.cpSync(path.join(${JSON.stringify(source)}, name), path.join(${JSON.stringify(sandbox.repo)}, name), { recursive: true });\n} else if (exact(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) process.exitCode = 1;\nelse if (process.cwd() === ${JSON.stringify(sandbox.repo)} && [\n  ['fetch', 'origin', '+main:refs/remotes/origin/main'], ['fetch', '--quiet', 'origin', '+main:refs/remotes/origin/main'], ['checkout', 'main'], ['merge', 'origin/main'], ['stash', 'push', '--include-untracked']\n].some(exact)) {\n  if (args[0] === 'fetch' && JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath(sandbox))}, 'utf8')).name === 'self-update') { process.stderr.write('Simulated sandbox fetch failure\\n'); process.exitCode = 1; }\n}\nelse { process.stderr.write('Unsupported sandbox Git operation\\n'); process.exitCode = 2; }\n`, { mode: 0o755 });
    installRepositoryFixture(sandbox.tools, path.join(sandbox.remote, 'repository.json'), true);
    const softwareUpdate = path.join(sandbox.tools, 'softwareupdate');
    fs.writeFileSync(softwareUpdate, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (JSON.stringify(args) !== JSON.stringify(['-ia'])) { process.stderr.write('Unsupported sandbox softwareupdate operation\\n'); process.exitCode = 2; }\nelse { fs.appendFileSync(${JSON.stringify(sandbox.log)}, 'softwareupdate:-ia\\n'); const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath(sandbox))}, 'utf8')).name;\n  if (scenario === 'update-failure') { process.stderr.write('Simulated sandbox macOS update failure\\n'); process.exitCode = 1; }\n  else if (scenario === 'update-interrupt') { fs.writeFileSync(${JSON.stringify(path.join(sandbox.root, 'update-stage.ready'))}, 'ready'); process.stdout.write('Sandbox update stage ready for interruption\\n'); setInterval(() => {}, 1000); }\n  else process.stdout.write('Simulated macOS update; no system changes.\\n'); }\n`, { mode: 0o755 });
    for (const file of [git, path.join(sandbox.tools, 'gh'), softwareUpdate, sandbox.guard]) sandbox.expected.set(file, fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(path.join(sandbox.home, '.zshrc'), '# Harmless onboarding QA fixture\nexport BALLIN_QA_EXAMPLE=1\n');
    resetRemote(sandbox);
    return sandbox;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
};
const runSandbox = (sandbox: Sandbox, args: string[], input?: string, timeout = sandboxCommandTimeout) => {
  const env = sandboxEnvironment(sandbox);
  recordSession(sandbox, [], true);
  const result = spawnSync(
    args[0] === 'install' ? path.join(source, 'install.sh') : path.join(sandbox.bin, 'ballin'),
    args[0] === 'install' ? [] : args,
    { cwd: sandbox.home, env, input, encoding: 'utf8', timeout, detached: true },
  );
  if (result.pid) {
    recordSession(sandbox, [result.pid]);
    if (processIsAlive(-result.pid)) {
      try { process.kill(-result.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 5000;
      while (processIsAlive(-result.pid) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      if (processIsAlive(-result.pid)) throw new Error('Sandbox child shutdown could not be verified; preserving session marker');
    }
    fs.rmSync(path.join(sandbox.root, '.active'));
  } else if (result.error) {
    // spawnSync returned without starting a child, so no process group exists.
    fs.rmSync(path.join(sandbox.root, '.active'));
  }
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`Sandbox command exceeded the ${timeout}ms test timeout`);
  return result;
};

module.exports = { createSandbox, validateSandbox, sandboxEnvironment, resetSandbox, resetRemote, cleanupSandbox, runSandbox, recordSession, processIsAlive, sandboxCommandTimeout, sandboxSuiteTimeout };
export type { Sandbox };
