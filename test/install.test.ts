const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installPath = path.join(__dirname, '..', 'install.sh');
const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md';
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';

type RunInstallOptions = {
  env?: NodeJS.ProcessEnv;
};

describe('install', () => {
  let homeDir: string;
  let toolDir: string;
  let repoDir: string;
  let commandLogPath: string;

  const writeExecutable = (name: string, contents: string, directory = toolDir) => {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const linkCommand = (name: string) => {
    const commandPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((commandDirectory) => path.join(commandDirectory, name))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${name} is required to run the install test harness`);
    fs.symlinkSync(commandPath, path.join(toolDir, name));
  };

  const writeCurrentCheckout = ({ repoUpdate = true, installSetup = true } = {}) => {
    fs.mkdirSync(path.join(repoDir, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'bin'), { recursive: true });
    if (repoUpdate) {
      fs.writeFileSync(path.join(repoDir, 'commands', 'repo_update.ts'), '');
    }
    if (installSetup) {
      fs.writeFileSync(path.join(repoDir, 'commands', 'install_setup.ts'), '');
    }
  };

  const installGitStub = () => {
    writeExecutable('git', `#!/usr/bin/env bash
printf 'git:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1" in
  clone)
    if [ "$2:$3" != 'https://github.com/JBallin/ballin-scripts.git:.ballin-scripts' ]; then
      exit 2
    fi
    mkdir -p "$HOME/.ballin-scripts/commands" "$HOME/.ballin-scripts/bin"
    : > "$HOME/.ballin-scripts/commands/repo_update.ts"
    : > "$HOME/.ballin-scripts/commands/install_setup.ts"
    exit "$FAKE_GIT_CLONE_STATUS"
    ;;
  fetch)
    exit "$FAKE_GIT_FETCH_STATUS"
    ;;
  checkout)
    exit "$FAKE_GIT_CHECKOUT_STATUS"
    ;;
  merge)
    if [ "$FAKE_GIT_MERGE_STATUS" = '0' ]; then
      mkdir -p "$HOME/.ballin-scripts/commands"
      : > "$HOME/.ballin-scripts/commands/repo_update.ts"
      : > "$HOME/.ballin-scripts/commands/install_setup.ts"
    fi
    exit "$FAKE_GIT_MERGE_STATUS"
    ;;
  *)
    exit 2
    ;;
esac
`);
  };

  const installNodeStub = () => {
    writeExecutable('node', `#!/usr/bin/env bash
if [ "$1" = '-p' ]; then
  printf '%s\\n' "$FAKE_NODE_SUPPORTED"
  exit 0
fi
case "$1" in
  "$HOME/.ballin-scripts/commands/repo_update.ts")
    printf 'node:repo_update %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    exit "$FAKE_REPO_UPDATE_STATUS"
    ;;
  "$HOME/.ballin-scripts/commands/install_setup.ts")
    printf 'node:install_setup %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    exit "$FAKE_SETUP_STATUS"
    ;;
  *)
    printf 'unexpected node command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  };

  const installBaseCommands = () => {
    linkCommand('bash');
    linkCommand('mkdir');
    installGitStub();
    installNodeStub();
  };

  const runInstall = ({ env = {} }: RunInstallOptions = {}) => spawnSync(installPath, [], {
    encoding: 'utf8',
    env: {
      HOME: homeDir,
      PATH: toolDir,
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_GIT_CLONE_STATUS: '0',
      FAKE_GIT_FETCH_STATUS: '0',
      FAKE_GIT_CHECKOUT_STATUS: '0',
      FAKE_GIT_MERGE_STATUS: '0',
      FAKE_NODE_SUPPORTED: 'true',
      FAKE_REPO_UPDATE_STATUS: '0',
      FAKE_SETUP_STATUS: '0',
      ...env,
    },
  });

  const commandLog = () => (fs.existsSync(commandLogPath)
    ? fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').filter(Boolean)
    : []);

  const setupCommand = () => `node:install_setup ${repoDir}/commands/install_setup.ts setup ${repoDir} ${docsUrl} ${analyticsDocsUrl}`;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-'));
    toolDir = path.join(homeDir, 'tools');
    repoDir = path.join(homeDir, '.ballin-scripts');
    commandLogPath = path.join(homeDir, 'commands.log');
    fs.mkdirSync(toolDir);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('clones a missing checkout and delegates fresh setup to typed code', () => {
    installBaseCommands();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "🏀 let's ball...");
    assert.deepEqual(commandLog(), [
      'git:clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts',
      setupCommand(),
    ]);
  });

  it('updates an existing current checkout through the typed repo updater before setup', () => {
    installBaseCommands();
    writeCurrentCheckout();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commandLog(), [
      `node:repo_update ${repoDir}/commands/repo_update.ts ${repoDir}`,
      setupCommand(),
    ]);
  });

  it('uses the minimal Bash update bridge for stale checkouts without typed repo update', () => {
    installBaseCommands();
    writeCurrentCheckout({ repoUpdate: false, installSetup: false });

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commandLog(), [
      'git:fetch origin +main:refs/remotes/origin/main',
      'git:checkout main',
      'git:merge origin/main',
      setupCommand(),
    ]);
  });

  it('fails clearly when the stale checkout bridge cannot update', () => {
    installBaseCommands();
    writeCurrentCheckout({ repoUpdate: false, installSetup: false });

    const result = runInstall({ env: { FAKE_GIT_MERGE_STATUS: '24' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, `Unable to update ${repoDir} before setup`);
    assert.include(result.stdout, `Update or delete ${repoDir}`);
    assert.deepEqual(commandLog(), [
      'git:fetch origin +main:refs/remotes/origin/main',
      'git:checkout main',
      'git:merge origin/main',
    ]);
  });

  it('stops with guidance when Node.js is unavailable', () => {
    linkCommand('bash');
    writeCurrentCheckout();

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js is required');
    assert.include(result.stdout, 'Node.js 24.12 or newer with nvm');
    assert.include(result.stdout, 'docs/README.md');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.deepEqual(commandLog(), []);
  });

  it('stops with guidance when Node.js is below the supported version', () => {
    installBaseCommands();
    writeCurrentCheckout();

    const result = runInstall({ env: { FAKE_NODE_SUPPORTED: 'false' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js 24.12 or newer is required');
    assert.include(result.stdout, 'Node.js 24.12 or newer with nvm');
    assert.include(result.stdout, 'docs/README.md');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.deepEqual(commandLog(), []);
  });

  it('returns the typed setup status when setup fails', () => {
    installBaseCommands();
    writeCurrentCheckout();

    const result = runInstall({ env: { FAKE_SETUP_STATUS: '27' } });

    assert.equal(result.status, 27);
    assert.deepEqual(commandLog(), [
      `node:repo_update ${repoDir}/commands/repo_update.ts ${repoDir}`,
      setupCommand(),
    ]);
  });
});
