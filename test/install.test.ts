const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installPath = path.join(__dirname, '..', 'install.sh');
const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md';
const troubleshootingUrl = `${docsUrl}#health-and-recovery`;
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md#what-will-analytics-share';

type RunInstallOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string;
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
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');
    fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'test', 'inspect.ts'), `require('fs').writeFileSync(${JSON.stringify(path.join(homeDir, 'inspection-ran'))}, 'ran');`);
    if (repoUpdate) {
      fs.writeFileSync(path.join(repoDir, 'commands', 'repo_update.ts'), '');
    }
    if (installSetup) {
      fs.writeFileSync(path.join(repoDir, 'commands', 'install_setup.ts'), '');
    }
  };

  const installGitStub = () => {
    writeExecutable('git', `#!/usr/bin/env bash
case "$1" in
  --version)
    exit "$FAKE_GIT_VERSION_STATUS"
    ;;
  clone)
    printf 'git:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    if [ "$2:$3" != 'https://github.com/JBallin/ballin-scripts.git:.ballin-scripts' ]; then
      exit 2
    fi
    mkdir -p "$HOME/.ballin-scripts/commands" "$HOME/.ballin-scripts/bin"
    : > "$HOME/.ballin-scripts/commands/repo_update.ts"
    : > "$HOME/.ballin-scripts/commands/install_setup.ts"
    if [ "$FAKE_GIT_CLONE_STATUS" != 0 ]; then printf '%s\\n' "\${FAKE_GIT_ERROR:-}" >&2; fi
    if [ -n "\${FAKE_GIT_CLONE_SIGNAL:-}" ]; then kill -"$FAKE_GIT_CLONE_SIGNAL" "$$"; fi
    exit "$FAKE_GIT_CLONE_STATUS"
    ;;
  fetch)
    printf 'git:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    exit "$FAKE_GIT_FETCH_STATUS"
    ;;
  checkout)
    printf 'git:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    exit "$FAKE_GIT_CHECKOUT_STATUS"
    ;;
  merge)
    printf 'git:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
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
  printf 'probe\\n' >> "$FAKE_NODE_PROBE_LOG"
  if [ "\${FAKE_NODE_RAW_OUTPUT+x}" = x ]; then
    printf '%s\\n' "$FAKE_NODE_RAW_OUTPUT"
  else
    "$TEST_NODE_RUNTIME" -e 'Object.defineProperty(process.versions, "node", { value: process.env.FAKE_NODE_VERSION }); console.log(eval(process.argv[1]));' "$2"
  fi
  exit "$FAKE_NODE_PROBE_STATUS"
fi
case "$1" in
  "$HOME/.ballin-scripts/commands/repo_update.ts")
    printf 'node:repo_update %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    if [ "$FAKE_REPO_UPDATE_STATUS" != 0 ]; then printf '%s\\n' "\${FAKE_REPO_UPDATE_ERROR:-}" >&2; fi
    exit "$FAKE_REPO_UPDATE_STATUS"
    ;;
  "$HOME/.ballin-scripts/commands/install_setup.ts")
    printf 'node:install_setup %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
    exit "$FAKE_SETUP_STATUS"
    ;;
  "$HOME/.ballin-scripts/test/inspect.ts")
    exec "$TEST_NODE_RUNTIME" "$@"
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

  const runInstall = ({ env = {}, input = 'y\n' }: RunInstallOptions = {}) => spawnSync(installPath, [], {
    encoding: 'utf8',
    input,
    env: {
      HOME: homeDir,
      PATH: toolDir,
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_GIT_VERSION_STATUS: '0',
      FAKE_GIT_CLONE_STATUS: '0',
      FAKE_GIT_FETCH_STATUS: '0',
      FAKE_GIT_CHECKOUT_STATUS: '0',
      FAKE_GIT_MERGE_STATUS: '0',
      FAKE_NODE_VERSION: '24.12.0',
      FAKE_NODE_PROBE_STATUS: '0',
      FAKE_NODE_PROBE_LOG: path.join(homeDir, 'node-probes'),
      TEST_NODE_RUNTIME: process.execPath,
      FAKE_REPO_UPDATE_STATUS: '0',
      FAKE_SETUP_STATUS: '0',
      ...env,
    },
  });

  const commandLog = () => (fs.existsSync(commandLogPath)
    ? fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').filter(Boolean)
    : []);

  const setupCommand = (mode = 'refresh') => `node:install_setup ${repoDir}/commands/install_setup.ts setup ${repoDir} ${docsUrl} ${analyticsDocsUrl} ${mode}`;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-'));
    toolDir = path.join(homeDir, 'tools');
    repoDir = path.join(homeDir, '.ballin-scripts');
    commandLogPath = path.join(homeDir, 'commands.log');
    fs.mkdirSync(toolDir);
  });

  afterEach(() => {
    assert.isFalse(fs.existsSync(path.join(homeDir, 'inspection-ran')));
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  for (const scenario of ['standalone', 'embedded', 'failure', 'declined', 'eof']) {
    it(`ends installer output with terminal guidance only on standalone success: ${scenario}`, () => {
      installBaseCommands();
      const result = runInstall({
        env: { BALLIN_DEFER_TERMINAL_GUIDANCE: scenario === 'embedded' ? '1' : '0', FAKE_SETUP_STATUS: scenario === 'failure' ? '7' : '0' },
        input: scenario === 'declined' ? 'n\n' : scenario === 'eof' ? '' : 'y\n',
      });
      assert.equal(result.status, scenario === 'failure' ? 7 : 0, result.stdout + result.stderr);
      const guidance = 'Setup complete! Open a new Terminal to run `ballin`.';
      assert.equal(result.stdout.split(guidance).length - 1, scenario === 'standalone' ? 1 : 0);
      if (scenario === 'standalone') assert.match(result.stdout, /\n\nSetup complete! Open a new Terminal to run `ballin`\.\n$/u);
    });
  }
  it('separates checkout/update output from the compact typed setup summary', () => {
    installBaseCommands(); writeCurrentCheckout();
    const node = path.join(toolDir, 'node');
    fs.writeFileSync(node, fs.readFileSync(node, 'utf8').replace('exit "$FAKE_SETUP_STATUS"',
      'printf "Validated private backup: https://github.com/fixture-user/ballin-backups\\nSensitive sources: excluded\\nAutomatic backup during update: disabled\\n"; exit "$FAKE_SETUP_STATUS"'));
    const result = runInstall();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '\n\nValidated private backup: https://github.com/fixture-user/ballin-backups\nSensitive sources: excluded\nAutomatic backup during update: disabled\n');
  });

  for (const existing of [false, true]) {
    it(`keeps the banner before Git output and separates typed setup (${existing ? 'update' : 'clone'})`, () => {
      installBaseCommands();
      if (existing) writeCurrentCheckout();
      const tool = path.join(toolDir, existing ? 'node' : 'git');
      const marker = existing ? '    exit "$FAKE_REPO_UPDATE_STATUS"' : '    exit "$FAKE_GIT_CLONE_STATUS"';
      fs.writeFileSync(tool, fs.readFileSync(tool, 'utf8').replace(marker, '    printf \'Git output fixture.\\n\'\n' + marker));
      const node = path.join(toolDir, 'node');
      fs.writeFileSync(node, fs.readFileSync(node, 'utf8').replace('    exit "$FAKE_SETUP_STATUS"', '    printf \'Typed setup fixture.\\n\'\n    exit "$FAKE_SETUP_STATUS"'));
      const result = runInstall();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.isTrue(result.stdout.startsWith("🏀 let's ball...\n"), result.stdout);
      assert.include(result.stdout, 'Git output fixture.\n\nTyped setup fixture.\n\nSetup complete! Open a new Terminal to run `ballin`.\n');
      assert.equal(result.stdout.split('Setup complete!').length - 1, 1);
    });
  }

  it('clones a missing checkout and delegates fresh setup to typed code', () => {
    installBaseCommands();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.notInclude(result.stdout, 'Detected Node.js');
    assert.include(result.stdout, "🏀 let's ball...");
    assert.include(result.stdout, 'Installation plan');
    assert.include(result.stdout, `Clone Ballin into ${repoDir} and create its config there.`);
    assert.include(result.stdout, `otherwise from ${homeDir}/.local/bin.`);
    assert.include(result.stdout, 'An existing non-directory command target may be replaced.');
    assert.notInclude(result.stdout, 'private GitHub');
    assert.notInclude(result.stdout, 'analytics');
    assert.notInclude(result.stdout, '.backup-cache');
    assert.notInclude(result.stdout, 'secret-Gist');
    assert.notInclude(result.stdout, 'remote Gist');
    assert.include(result.stdout, `\n${docsUrl}#what-will-installation-change\n`);
    assert.lengthOf(result.stdout.match(/https:\/\/[^\s]+/gu) ?? [], 1);
    assert.deepEqual(commandLog(), [
      'git:clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts',
      setupCommand('fresh'),
    ]);
  });

  it('makes no installation changes when fresh-install confirmation is declined', () => {
    installBaseCommands();

    const result = runInstall({ input: 'n\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.notInclude(result.stdout, 'Detected Node.js');
    assert.include(result.stdout, 'Installation cancelled; no installation changes were made.');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('makes no installation changes when fresh-install confirmation receives EOF', () => {
    installBaseCommands();

    const result = runInstall({ input: '' });

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.notInclude(result.stdout, 'Detected Node.js');
    assert.include(result.stdout, 'Installation cancelled; no installation changes were made.');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('updates an existing current checkout through the typed repo updater before setup', () => {
    installBaseCommands();
    writeCurrentCheckout();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.notInclude(result.stdout, 'Detected Node.js');
    assert.notInclude(result.stdout, 'Installation plan');
    assert.deepEqual(commandLog(), [
      `node:repo_update ${repoDir}/commands/repo_update.ts ${repoDir}`,
      setupCommand(),
    ]);
  });

  for (const typed of [true, false]) {
    for (const status of [130, 143]) {
      it(`preserves interrupted updater status ${status} through the ${typed ? 'typed' : 'legacy'} installer route`, () => {
        installBaseCommands(); writeCurrentCheckout({ repoUpdate: typed });
        const result = runInstall({ env: typed
          ? { FAKE_REPO_UPDATE_STATUS: String(status) } : { FAKE_GIT_FETCH_STATUS: String(status) } });
        assert.equal(result.status, status, result.stdout + result.stderr);
        assert.notInclude(result.stdout + result.stderr, 'Update or delete');
        assert.notInclude(result.stdout, 'Setup complete');
        assert.notInclude(result.stdout, 'Unable to update');
        const log = fs.readFileSync(commandLogPath, 'utf8');
        assert.include(log, typed ? 'node:repo_update' : 'git:fetch');
        for (const later of ['node:install_setup', 'git:checkout', 'git:merge']) assert.notInclude(log, later);
        assert.equal(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'), '{}\n');
        assert.isFalse(fs.existsSync(path.join(homeDir, 'inspection-ran')));
      });
    }
  }

  it('retries an incomplete cloned checkout with fresh setup when no config was created', () => {
    installBaseCommands();

    const first = runInstall({ env: { FAKE_SETUP_STATUS: '27' } });

    assert.equal(first.status, 27);
    assert.deepEqual(commandLog(), [
      'git:clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts',
      setupCommand('fresh'),
    ]);
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));

    fs.writeFileSync(commandLogPath, '');
    const retry = runInstall();

    assert.equal(retry.status, 0, retry.stderr);
    assert.notInclude(retry.stdout, 'Installation plan');
    assert.include(retry.stdout, `${docsUrl}#what-will-installation-change\n`);
    assert.deepEqual(commandLog(), [
      `node:repo_update ${repoDir}/commands/repo_update.ts ${repoDir}`,
      setupCommand('fresh'),
    ]);
  });

  it('uses the minimal Bash update bridge for stale checkouts without typed repo update', () => {
    installBaseCommands();
    writeCurrentCheckout({ repoUpdate: false, installSetup: false });

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.notInclude(result.stdout, 'Detected Node.js');
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
    assert.equal(result.stdout.split(troubleshootingUrl).length - 1, 1);
    assert.isBelow(result.stdout.indexOf('Unable to update'), result.stdout.indexOf(troubleshootingUrl));
    assert.deepEqual(commandLog(), [
      'git:fetch origin +main:refs/remotes/origin/main',
      'git:checkout main',
      'git:merge origin/main',
    ]);
  });

  it('stops with guidance when Node.js is unavailable', () => {
    linkCommand('bash');
    installGitStub();

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js 24.12 or newer is required');
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.include(result.stdout, 'Install a supported version with nvm');
    assert.include(result.stdout, 'docs/optional-capabilities.md#nodejs');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.notInclude(result.stdout, 'Installation plan');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('stops with guidance before clone or update when Git is unavailable', () => {
    linkCommand('bash');

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Git is required before install can continue');
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.include(result.stdout, 'Install Git, then run this installer again');
    assert.include(result.stdout, 'run this installer again');
    assert.notInclude(result.stdout, 'Installation plan');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('stops with guidance before clone or update when Git cannot run', () => {
    linkCommand('bash');
    installGitStub();

    const result = runInstall({ env: { FAKE_GIT_VERSION_STATUS: '69' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Git is required before install can continue');
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.include(result.stdout, 'Install Git, then run this installer again');
    assert.include(result.stdout, 'run this installer again');
    assert.notInclude(result.stdout, 'Installation plan');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('stops with guidance when Node.js is below the supported version', () => {
    installBaseCommands();

    const result = runInstall({ env: { FAKE_NODE_VERSION: '24.11.9' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js 24.12 or newer is required');
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.include(result.stdout, 'Install a supported version with nvm');
    assert.include(result.stdout, 'docs/optional-capabilities.md#nodejs');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.notInclude(result.stdout, 'Installation plan');
    assert.deepEqual(commandLog(), []);
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('accepts a newer Node major without extra diagnostic output or probes', () => {
    installBaseCommands();
    const result = runInstall({ env: { FAKE_NODE_VERSION: '25.0.0' }, input: 'n\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, 'Detected Node.js');
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.equal(fs.readFileSync(path.join(homeDir, 'node-probes'), 'utf8'), 'probe\n');
    assert.deepEqual(commandLog(), []);
  });

  for (const version of ['22.14.0', '24.11.9', '24.11.0-pre']) {
    it(`shows the detected incompatible Node.js ${version} using one probe`, () => {
      installBaseCommands();
      const result = runInstall({ env: { FAKE_NODE_VERSION: version } });
      assert.equal(result.status, 1);
      assert.include(result.stdout, `Node.js 24.12 or newer is required. Detected Node.js ${version}.`);
      assert.include(result.stdout, 'Install a supported version with nvm');
      assert.notInclude(result.stdout, troubleshootingUrl);
      assert.equal(result.stderr, '');
      assert.deepEqual(commandLog(), []);
      assert.equal(fs.readFileSync(path.join(homeDir, 'node-probes'), 'utf8'), 'probe\n');
      assert.isFalse(fs.existsSync(repoDir));
    });
  }

  for (const [label, env] of [
    ['malformed runtime', { FAKE_NODE_VERSION: 'DUMMY_PRIVATE_SECRET' }],
    ['malformed supported-looking runtime', { FAKE_NODE_VERSION: '24.12.invalid' }],
    ['boolean-looking runtime', { FAKE_NODE_VERSION: 'true' }],
    ['empty output', { FAKE_NODE_RAW_OUTPUT: '' }],
    ['malformed output', { FAKE_NODE_RAW_OUTPUT: 'DUMMY_PRIVATE_SECRET' }],
    ['multiline output', { FAKE_NODE_RAW_OUTPUT: '22.14.0\nDUMMY_PRIVATE_SECRET' }],
    ['failed version probe', { FAKE_NODE_RAW_OUTPUT: '22.14.0', FAKE_NODE_PROBE_STATUS: '7' }],
    ['failed supported probe', { FAKE_NODE_RAW_OUTPUT: 'true', FAKE_NODE_PROBE_STATUS: '7' }],
  ] as [string, NodeJS.ProcessEnv][]) {
    it(`keeps prerequisite guidance without inventing a version for ${label}`, () => {
      installBaseCommands();
      const result = runInstall({ env });
      assert.equal(result.status, 1);
      assert.include(result.stdout, 'Node.js 24.12 or newer is required.\n');
      assert.notInclude(result.stdout, 'Detected Node.js');
      assert.notInclude(result.stdout, troubleshootingUrl);
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_SECRET');
      assert.equal(result.stderr, '');
      assert.deepEqual(commandLog(), []);
      assert.equal(fs.readFileSync(path.join(homeDir, 'node-probes'), 'utf8'), 'probe\n');
      assert.isFalse(fs.existsSync(repoDir));
    });
  }

  for (const interruption of ['SIGINT', 'SIGTERM', 130, 143] as const) {
    it(`preserves fresh clone interruption ${interruption} without setup or ordinary failure guidance`, () => {
      installBaseCommands();
      const earlier = path.join(homeDir, 'earlier-approved-change');
      fs.writeFileSync(earlier, 'keep this change\n');
      const result = runInstall({ env: {
        FAKE_GIT_CLONE_SIGNAL: typeof interruption === 'string' ? interruption.slice(3) : undefined,
        FAKE_GIT_CLONE_STATUS: typeof interruption === 'number' ? String(interruption) : '0',
      } });
      assert.equal(result.status, interruption === 'SIGINT' || interruption === 130 ? 130 : 143, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Unable to prepare');
      assert.notInclude(result.stdout, troubleshootingUrl);
      assert.notInclude(result.stdout, 'Setup complete!');
      assert.deepEqual(commandLog(), ['git:clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts']);
      assert.isTrue(fs.existsSync(path.join(repoDir, 'commands', 'install_setup.ts')), 'partial checkout remains');
      assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
      assert.equal(fs.readFileSync(earlier, 'utf8'), 'keep this change\n');
    });
  }

  for (const [label, current, env, message] of [
    ['clone failure', false, { FAKE_GIT_CLONE_STATUS: '17', FAKE_GIT_ERROR: 'fixture Git failure' }, 'Unable to prepare'],
    ['typed update failure', true, { FAKE_REPO_UPDATE_STATUS: '19', FAKE_REPO_UPDATE_ERROR: 'fixture update failure' }, 'Unable to update'],
    ['missing typed setup', true, {}, 'Unable to update'],
  ] as [string, boolean, NodeJS.ProcessEnv, string][]) {
    it(`links checkout troubleshooting once after ${label} without running the helper`, () => {
      installBaseCommands();
      if (current) writeCurrentCheckout({ installSetup: label !== 'missing typed setup' });
      const result = runInstall({ env });
      assert.equal(result.status, 1);
      assert.include(result.stdout, message);
      assert.equal(result.stdout.split(troubleshootingUrl).length - 1, 1);
      assert.isBelow(result.stdout.indexOf(message), result.stdout.indexOf(troubleshootingUrl));
      assert.equal(result.stderr, env.FAKE_GIT_ERROR ? `${env.FAKE_GIT_ERROR}\n` : env.FAKE_REPO_UPDATE_ERROR ? `${env.FAKE_REPO_UPDATE_ERROR}\n` : '');
      assert.isFalse(commandLog().some((line: string) => line.startsWith('node:install_setup')));
    });
  }

  it('returns the typed setup status when setup fails', () => {
    installBaseCommands();
    writeCurrentCheckout();

    const result = runInstall({ env: { FAKE_SETUP_STATUS: '27' } });

    assert.equal(result.status, 27);
    assert.notInclude(result.stdout, troubleshootingUrl);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `node:repo_update ${repoDir}/commands/repo_update.ts ${repoDir}`,
      setupCommand(),
    ]);
  });
});
