const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { processIsAlive } = require('./process_liveness.ts');
const { activeScenario, scenarioPath } = require('./sandbox_scenarios.ts');
const { fixtureState, installRepositoryFixture } = require('./repository.ts');
import type { FixtureState } from './repository.ts';

type Sandbox = {
  quickstart: boolean; root: string; home: string; tools: string; bin: string; repo: string; remote: string;
  log: string; scratch: string; source: string; guard: string; expected: Map<string, string>; links: Map<string, string>;
};
const markerName = '.ballin-onboarding-sandbox.json';
const source = path.resolve(__dirname, '../..');
const systemTools = ['uname', 'bash', 'cat', 'cmp', 'cp', 'ls', 'mkdir', 'mktemp', 'rm', 'tail'];
const quickstartSystemTools = ['awk', 'chmod', 'grep', 'ln', 'mv', 'readlink', 'shasum'];
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
  if (JSON.parse(fs.readFileSync(path.join(sandbox.root, markerName), 'utf8')).quickstart !== sandbox.quickstart) {
    throw new Error('Sandbox mode was changed');
  }
  for (const directory of [sandbox.home, sandbox.tools, sandbox.bin, sandbox.scratch, sandbox.remote]) {
    if (fs.realpathSync(directory) !== directory) throw new Error('Sandbox directory was replaced');
  }
  if (existsWithoutFollowingLinks(sandbox.repo) && (fs.lstatSync(sandbox.repo).isSymbolicLink()
    || fs.realpathSync(sandbox.repo) !== sandbox.repo)) throw new Error('Sandbox checkout was replaced');
  const state = path.join(sandbox.remote, 'repository.json');
  if (existsWithoutFollowingLinks(state) && fs.lstatSync(state).isSymbolicLink()) throw new Error('Sandbox remote state was replaced');
  if (fs.readdirSync(sandbox.tools).sort().join(',') !== [...systemTools, ...(sandbox.quickstart ? [...quickstartSystemTools, 'sw_vers'] : []), 'curl', 'node', 'git', 'gh', 'softwareupdate'].sort().join(',')
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
    HOME: sandbox.home, PATH: sandbox.quickstart && !existsWithoutFollowingLinks(sandbox.repo)
      ? sandbox.tools : [sandbox.tools, sandbox.bin].join(path.delimiter),
    ...(sandbox.quickstart ? { SHELL: '/bin/bash' } : {}),
    TMPDIR: sandbox.scratch, PWD: sandbox.home,
    GH_CONFIG_DIR: path.join(sandbox.home, '.config/gh'), XDG_CONFIG_HOME: path.join(sandbox.home, '.config'),
    BALLIN_NO_ANALYTICS: '1', BALLIN_QA_ROOT: sandbox.root, BALLIN_QA_NODE: process.execPath,
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
const createSandbox = (options: { quickstart?: boolean } = {}): Sandbox => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-onboarding-')));
  const sandbox: Sandbox = {
    quickstart: options.quickstart ?? false, root, source, home: path.join(root, 'home'), tools: path.join(root, 'tools'),
    bin: path.join(root, 'home/.local/bin'), repo: path.join(root, 'home/.ballin-scripts'),
    remote: path.join(root, 'remote'), log: path.join(root, 'commands.log'), scratch: path.join(root, 'tmp'),
    guard: path.join(root, 'guard.ts'), expected: new Map(), links: new Map(),
  };
  try {
    fs.writeFileSync(scenarioPath(sandbox), JSON.stringify({ name: 'none' }));
    fs.writeFileSync(path.join(root, markerName), JSON.stringify({ version: 1, root, quickstart: sandbox.quickstart }));
    [sandbox.home, sandbox.tools, sandbox.bin, sandbox.remote, sandbox.scratch].forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    for (const name of [...systemTools.filter(name => !sandbox.quickstart || name !== 'uname'), ...(sandbox.quickstart ? quickstartSystemTools : [])]) {
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
    fs.writeFileSync(git, `#!/usr/bin/env node\nconst fs = require('fs');\nconst path = require('path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(sandbox.log)}, 'git:' + args.join(' ') + '\\n');\nconst exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);\nif (exact(['--version'])) process.stdout.write('git version onboarding fixture\\n');\nelse if (exact(['clone', '--no-checkout', 'https://github.com/JBallin/ballin-scripts.git', ${JSON.stringify(sandbox.repo)}])) {\n  fs.mkdirSync(${JSON.stringify(sandbox.repo)}, { recursive: true });\n  for (const name of ['commands', 'config', 'bin', 'completions', 'package.json', 'install.sh', 'installer-contract.json']) fs.cpSync(path.join(${JSON.stringify(source)}, name), path.join(${JSON.stringify(sandbox.repo)}, name), { recursive: true });\n} else if (exact(['show', 'HEAD:commands/backup_scope.json']) && process.cwd() === ${JSON.stringify(sandbox.repo)}) {\n  const catalog = path.join(${JSON.stringify(sandbox.repo)}, 'commands/backup_scope.json');\n  if (fs.realpathSync(${JSON.stringify(sandbox.repo)}) !== ${JSON.stringify(sandbox.repo)}\n    || fs.realpathSync(catalog) !== catalog || !fs.lstatSync(catalog).isFile()) {\n    process.stderr.write('Sandbox backup scope catalog was replaced\\n'); process.exitCode = 2;\n  } else process.stdout.write(fs.readFileSync(catalog, 'utf8'));\n} else if (exact(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) process.exitCode = 1;\nelse if (process.cwd() === ${JSON.stringify(sandbox.repo)} && [\n  ['fetch', 'origin', '+main:refs/remotes/origin/main'], ['fetch', '--quiet', 'origin', '+main:refs/remotes/origin/main'], ['checkout', 'main'], ['merge', 'origin/main'], ['stash', 'push', '--include-untracked']\n].some(exact)) {\n  if (args[0] === 'fetch' && JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath(sandbox))}, 'utf8')).name === 'self-update') { process.stderr.write('Simulated sandbox fetch failure\\n'); process.exitCode = 1; }\n}\nelse { process.stderr.write('Unsupported sandbox Git operation\\n'); process.exitCode = 2; }\n`, { mode: 0o755 });
    installRepositoryFixture(sandbox.tools, path.join(sandbox.remote, 'repository.json'), true);
    const softwareUpdate = path.join(sandbox.tools, 'softwareupdate');
    fs.writeFileSync(softwareUpdate, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (JSON.stringify(args) !== JSON.stringify(['-ia'])) { process.stderr.write('Unsupported sandbox softwareupdate operation\\n'); process.exitCode = 2; }\nelse { fs.appendFileSync(${JSON.stringify(sandbox.log)}, 'softwareupdate:-ia\\n'); const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath(sandbox))}, 'utf8')).name;\n  if (scenario === 'update-failure') { process.stderr.write('Simulated sandbox macOS update failure\\n'); process.exitCode = 1; }\n  else if (scenario === 'update-interrupt') { fs.writeFileSync(${JSON.stringify(path.join(sandbox.root, 'update-stage.ready'))}, 'ready'); process.stdout.write('Sandbox update stage ready for interruption\\n'); setInterval(() => {}, 1000); }\n  else process.stdout.write('Simulated macOS update; no system changes.\\n'); }\n`, { mode: 0o755 });
    if (sandbox.quickstart) {
      const nvmFixture = path.join(sandbox.root, 'nvm-fixture.sh');
      fs.copyFileSync(path.join(__dirname, 'onboarding_nvm.sh'), nvmFixture);
      fs.chmodSync(nvmFixture, 0o700);
      sandbox.expected.set(nvmFixture, fs.readFileSync(nvmFixture, 'utf8'));
      const nvmInstaller = path.join(sandbox.root, 'nvm-install.sh');
      fs.writeFileSync(nvmInstaller, '#!/bin/bash\nset -eu\n[[ "$PROFILE" == /dev/null && "$NVM_DIR" == "$BALLIN_QA_ROOT/home/.config/nvm" ]] || exit 97\nmkdir -p "$NVM_DIR"\ncp "$BALLIN_QA_ROOT/nvm-fixture.sh" "$NVM_DIR/nvm.sh"\n', { mode: 0o700 });
      sandbox.expected.set(nvmInstaller, fs.readFileSync(nvmInstaller, 'utf8'));
      // Explicit test-only mode: downloads resolve only to the local installer,
      // prerequisites are fixture tools, and completion uses its existing TTY seam.
      const gh = path.join(sandbox.tools, 'gh');
      const originalGh = fs.readFileSync(gh, 'utf8').split('\n').slice(1).join('\n');
      fs.writeFileSync(gh, '#!/usr/bin/env node\nconst args = process.argv.slice(2).join(" ");\n'
        + 'if (args === "--version") console.log("gh fixture");\n'
        + 'else if (args === "auth status --help") console.log("--active");\n'
        + `else if (args.startsWith("auth status --active --hostname ")) { const fs = require('fs'); const state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(sandbox.remote, 'repository.json'))}, 'utf8')); fs.appendFileSync(${JSON.stringify(sandbox.log)}, 'gh-auth:' + args + '\\n'); if (args !== 'auth status --active --hostname ' + state.host) process.exit(97); process.exit(state.faults.auth ? 1 : 0); }\n`
        + 'else {\n' + originalGh + '\n}\n');
      for (const [name, body] of Object.entries({
        uname: 'if (process.argv[2] === "-s") console.log("Darwin"); else if (process.argv[2] === "-m") console.log("arm64"); else process.exit(97);',
        sw_vers: 'if (process.argv.slice(2).join(" ") !== "-productVersion") process.exit(97); console.log("13.5");',
        curl: `const fs = require('fs'); const args = process.argv.slice(2);\n`
          + `const publicScripts = new Map(['install.sh', 'quickstart.sh'].map(file => ['https://raw.githubusercontent.com/JBallin/ballin-scripts/main/' + file, file]));\n`
          + `if (args.length === 3 && args[0] === '-q' && args[1] === '-fsSL' && publicScripts.has(args[2])) { fs.writeFileSync(1, fs.readFileSync(${JSON.stringify(source)} + '/' + publicScripts.get(args[2]))); process.exit(0); }\n`
          + `const url=args.at(-3); const nvm=url==='https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh'; const file=nvm?'nvm-install.sh':url==='https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh'?'install.sh':null; if(!file || JSON.stringify(args.slice(0,-3))!==JSON.stringify(['-q','-fsSL','--proto','=https','--proto-redir','=https','--tlsv1.2'])) process.exit(97);\n`
          + `const target = args.at(-1); if (!target.startsWith(${JSON.stringify(sandbox.scratch + '/ballin-quickstart.')})) process.exit(97);\n`
          + `fs.copyFileSync((nvm ? ${JSON.stringify(sandbox.root)} : ${JSON.stringify(source)}) + '/' + file, target);`,
      })) {
        const file = path.join(sandbox.tools, name);
        fs.writeFileSync(file, '#!/usr/bin/env node\n' + body + '\n', { mode: 0o755 });
        sandbox.expected.set(file, fs.readFileSync(file, 'utf8'));
      }
    }
    // Canonical revision fixture: every accepted download is mapped to local data.
    const curl = path.join(sandbox.tools, 'curl');
    fs.writeFileSync(curl, `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2),sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const url=args.find(v=>v.startsWith('https://'));const output=args.includes('-o')?args[args.indexOf('-o')+1]:null;
const publicBase='https://raw.githubusercontent.com/JBallin/ballin-scripts/';
let data;
if(url==='https://api.github.com/repos/JBallin/ballin-scripts/git/ref/heads/main')data=JSON.stringify({object:{sha,type:'commit'}});
else if(url==='https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh')data=fs.readFileSync(${JSON.stringify(sandbox.root)}+'/nvm-install.sh');
else {
 const allowed=['install.sh','quickstart.sh','installer-contract.json','commands/repo_update.ts'];
 const file=allowed.find(f=>url===publicBase+sha+'/'+f || (['install.sh','quickstart.sh'].includes(f)&&url===publicBase+'main/'+f));
 if(!file)process.exit(97); data=fs.readFileSync(path.join(${JSON.stringify(source)},file));
}
if(output){if(!path.resolve(output).startsWith(${JSON.stringify(sandbox.scratch + '/')}))process.exit(97);fs.writeFileSync(output,data);if(args.includes('-w'))process.stdout.write('200');}
else if(args.length===3&&args[0]==='-q'&&args[1]==='-fsSL')process.stdout.write(data);else process.exit(97);
`, { mode: 0o755 });
    sandbox.expected.set(curl, fs.readFileSync(curl, 'utf8'));
    const legacyGit = fs.readFileSync(git, 'utf8');
    const revisionGit = `
const revisionArgs=process.argv.slice(2),revisionRoot=${JSON.stringify(sandbox.repo)},revisionSha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const same=a=>JSON.stringify(a)===JSON.stringify(revisionArgs);
let handled=true,answer='';
if(revisionArgs[0]!=='-C'&&process.cwd()!==revisionRoot)handled=false;
else if(same(['-C',revisionRoot,'rev-parse','--show-toplevel'])||same(['rev-parse','--show-toplevel']))answer=revisionRoot;
else if(same(['-C',revisionRoot,'remote','get-url','origin'])||same(['remote','get-url','origin']))answer='https://github.com/JBallin/ballin-scripts.git';
else if(same(['-C',revisionRoot,'for-each-ref','--format=%(refname)','refs/replace/'])||same(['for-each-ref','--format=%(refname)','refs/replace/']))answer='';
else if(same(['-C',revisionRoot,'ls-files','-v'])||same(['ls-files','-v']))answer='H package.json';
else if(same(['-C',revisionRoot,'config','--get','core.sparseCheckout'])||same(['config','--get','core.sparseCheckout']))process.exit(1);
else if(same(['rev-parse','--absolute-git-dir'])) {fs.mkdirSync(path.join(revisionRoot,'.git'),{recursive:true});answer=path.join(revisionRoot,'.git');}
else if(revisionArgs.includes('--git-path')) {const name=revisionArgs.at(-1);if(!/^[a-zA-Z0-9_.-]+$/.test(name))process.exit(97);fs.mkdirSync(path.join(revisionRoot,'.git'),{recursive:true});answer=path.join(revisionRoot,'.git',name);}
else if(revisionArgs.includes('status')&&revisionArgs.includes('--porcelain'))answer='';
else if(revisionArgs[0]==='rev-parse'&&['HEAD','FETCH_HEAD^{commit}'].includes(revisionArgs.at(-1)))answer=revisionSha;
else if(same(['symbolic-ref','-q','HEAD']))answer='refs/heads/main';
else if(revisionArgs[0]==='ls-tree'&&revisionArgs[1]===revisionSha&&revisionArgs[2]==='--'&&['install.sh','quickstart.sh','commands/repo_update.ts','commands/install_setup.ts','bin/ballin','package.json'].includes(revisionArgs[3]))answer='100644 blob '+revisionSha+'\\t'+revisionArgs[3];
else if(same(['show',revisionSha+':installer-contract.json']))answer=fs.readFileSync(path.join(${JSON.stringify(source)},'installer-contract.json'),'utf8');
else if(same(['fetch','--no-tags','https://github.com/JBallin/ballin-scripts.git',revisionSha])) {if(JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath(sandbox))},'utf8')).name==='self-update'){process.stderr.write('Simulated sandbox fetch failure\\n');process.exit(1);}}
else if(same(['checkout','--detach','--no-overwrite-ignore',revisionSha])||same(['merge','--ff-only','--no-overwrite-ignore',revisionSha])||same(['merge-base','--is-ancestor',revisionSha,revisionSha]))answer='';
else handled=false;
if(handled){fs.appendFileSync(${JSON.stringify(sandbox.log)},'git:'+revisionArgs.join(' ')+'\\n');process.stdout.write(answer);process.exit(0);}
`;
    fs.writeFileSync(git, legacyGit.replace("const args = process.argv.slice(2);", revisionGit + "\nconst args = process.argv.slice(2);"));
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
  if (args[0] === 'quickstart') {
    if (!sandbox.quickstart) throw new Error('Quickstart requires its explicit sandbox mode');
    env.PATH = sandbox.tools;
  }
  recordSession(sandbox, [], true);
  const result = spawnSync(
    args[0] === 'quickstart' ? path.join(source, 'quickstart.sh') : args[0] === 'install' ? path.join(source, 'install.sh') : path.join(sandbox.bin, 'ballin'),
    ['install', 'quickstart'].includes(args[0]) ? [] : args,
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
