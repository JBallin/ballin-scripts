const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installPath = path.join(__dirname, '..', 'install.sh');
type RunInstallOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string;
};

describe('install', () => {
  let homeDir: string;
  let binDir: string;
  let repoDir: string;
  let commandLogPath: string;

  const writeExecutable = (name: string, contents: string, directory = binDir) => {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const linkCommand = (name: string, directory = binDir) => {
    const commandPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((commandDirectory) => path.join(commandDirectory, name))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${name} is required to run the install test harness`);
    fs.symlinkSync(commandPath, path.join(directory, name));
  };

  const installBaseCommands = () => {
    ['chmod', 'cp', 'ln', 'mkdir', 'rm'].forEach((command) => linkCommand(command));
    writeExecutable('node', `#!/usr/bin/env bash
if [ "$1" = '-p' ]; then
  printf '%s\\n' "$FAKE_NODE_SUPPORTED"
  exit 0
fi
if [ "$1" = "$HOME/.ballin-scripts/commands/install_setup.ts" ]; then
  if [ ! -f "$1" ]; then
    exit 1
  fi
  printf 'node:install_setup %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
  shift
  if [ "$1" = 'configure' ]; then
    repo_dir="$2"
    docs_url="$3"
    if [ ! -f "$repo_dir/ballin.config.json" ]; then
      if ! cp "$repo_dir/config/.defaultConfig.json" "$repo_dir/ballin.config.json"; then
        exit 1
      fi
      printf "\\n🧠 Created 'ballin.config.json' file in root using default settings\\n"
      exit 0
    fi
    printf '%s' "$FAKE_UPDATE_OUTPUT"
  if [ -n "$FAKE_UPDATE_OUTPUT" ]; then
    printf '\\n👀 Docs: %s\\n' "$docs_url"
  fi
  exit "$FAKE_NODE_STATUS"
fi
if [ "$1" = 'gist' ]; then
  repo_dir="$2"
  docs_url="$3"
  gu_host_existed="$4"
  ballin_config="$repo_dir/bin/ballin_config"
  cd "$repo_dir" || exit 1
  gu_host="$("$ballin_config" get gu.host)"
  gu_id="$("$ballin_config" get gu.id)"
  if [ -n "$BALLIN_GU_HOST" ]; then
    "$ballin_config" set gu.host "$BALLIN_GU_HOST"
    gu_host="$("$ballin_config" get gu.host)"
  elif [ "$gu_id" = 'null' ] || [ "$gu_host_existed" = false ]; then
    read -rp "🤔 What GitHub host should be used for Gist backups? [$gu_host] " input_host
    if [ -n "$input_host" ]; then
      "$ballin_config" set gu.host "$input_host"
      gu_host="$("$ballin_config" get gu.host)"
    fi
  fi
  export GH_HOST="$gu_host"
  if [ ! -x "$(command -v gh)" ]; then
    printf '\\n⚠️  ERROR: GitHub CLI is required for Gist backup setup.\\n'
    printf '\\nInstall gh, authenticate it, then run this installer again.\\n'
    printf '\\nSetup guide: %s\\n' "$docs_url"
    printf '\\nRun after installing gh:\\n  gh auth login --hostname %s\\n' "$gu_host"
    exit 1
  fi
  if ! gh auth status --hostname "$gu_host" > /dev/null 2>&1; then
    printf '\\n⚠️  ERROR: gh is not authenticated for %s.\\n' "$gu_host"
    printf '\\nRun:\\n  gh auth login --hostname %s\\n' "$gu_host"
    printf '\\nThen run this installer again.\\n'
    exit 1
  fi
  if [ "$gu_id" = 'null' ]; then
    gist_description='### Backup of your dev environment
Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)
'
    expected_marker="$(printf '%s' "$gist_description")"
    read -rp '🤔 Do you already have a ballin-scripts backup gist? [y/N] ' YN
    if [ "$YN" = 'y' ] || [ "$YN" = 'Y' ]; then
      printf '\\n%s\\n' 'Welcome Back!'
      valid_gist_id=1
      while [ "$valid_gist_id" = 1 ]; do
        read -rp 'Enter your gist ID: ' gist_id
        if [ "$(gh gist view "$gist_id" --raw --filename '.MyConfig.md' 2>/dev/null)" = "$expected_marker" ]; then
          printf '\\n%s\\n' '👍 Storing your previous gist ID in your config:'
          if gh gist view "$gist_id" --raw --filename ballin_config > '.ballin.config.restore.tmp'; then
            cp '.ballin.config.restore.tmp' 'ballin.config.json'
            printf '\\n%s\\n' '♻️  Restored ballin.config.json from your backup gist.'
          else
            printf '\\n%s\\n' 'ℹ️  No ballin_config snapshot was found in that gist; keeping the local config defaults.'
          fi
          rm -f '.ballin.config.restore.tmp'
          "$ballin_config" set gu.id "$gist_id"
          valid_gist_id=0
        else
          printf "\\n⚠️  INVALID: Expected backup marker in gist '%s'.\\n" "$gist_id"
        fi
      done
    fi
    if [ "$("$ballin_config" get gu.id)" = 'null' ]; then
      printf '%s' "$gist_description" > '.MyConfig.md'
      gist_url="$(gh gist create '.MyConfig.md' --desc "$gist_description")"
      printf "\\n💥 Created a secret gist titled '.MyConfig' at the following URL:\\n%s\\n" "$gist_url"
      gist_id="\${gist_url##*/}"
      printf '\\n%s\\n' '🧳 Storing your new gist ID in your config...'
      "$ballin_config" set gu.id "$gist_id"
      rm -f '.MyConfig.md'
    fi
  fi
  exit 0
fi
  if [ "$1" != 'symlink-binaries' ]; then
    exit 2
  fi
  repo_dir="$2"
  bin_dir="$3"
  if ! mkdir -p "$bin_dir"; then
    printf '\\n⚠️  ERROR: Unable to create %s\\n' "$bin_dir"
    exit 1
  fi
  for bin in "$repo_dir/bin/"*; do
    if ! ln -sfn "$bin" "$bin_dir/\${bin##*/}"; then
      printf '\\n⚠️  ERROR: Unable to symlink binaries into %s\\n' "$bin_dir"
      exit 1
    fi
  done
  printf '\\n💪 symlinked binaries into %s\\n' "$bin_dir"
  exit 0
fi
printf '%s' "$FAKE_UPDATE_OUTPUT"
exit "$FAKE_NODE_STATUS"
`);
  };

  const installConfigCommand = () => {
    writeExecutable('ballin_config', `#!/usr/bin/env bash
printf 'ballin_config:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  get:gu.host) printf '%s\\n' 'github.example.test' ;;
  get:gu.id) printf '%s\\n' 'existing-gist-id' ;;
esac
`, path.join(repoDir, 'bin'));
  };

  const installAdoptableConfigCommand = () => {
    writeExecutable('ballin_config', `#!/usr/bin/env bash
printf 'ballin_config:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
gist_id_file="$HOME/.configured-gist-id"
host_file="$HOME/.configured-gu-host"
configured_host='github.example.test'
if [ -f "$host_file" ]; then
  while IFS= read -r stored_host; do
    configured_host="$stored_host"
  done < "$host_file"
fi
case "$1:$2" in
  get:gu.host) printf '%s\\n' "$configured_host" ;;
  get:gu.id)
    if [ -f "$gist_id_file" ]; then
      while IFS= read -r gist_id; do
        printf '%s\\n' "$gist_id"
      done < "$gist_id_file"
    else
      printf '%s\\n' 'null'
    fi
    ;;
  set:gu.host)
    printf '%s\\n' "$3" > "$host_file"
    printf '%s\\n' "\\"gu.host\\" set to: \\"$3\\""
    ;;
  set:gu.id)
    printf '%s\\n' "$3" > "$gist_id_file"
    printf '{"up":{"cleanup":"false","ballin":"true","gu":"true","softwareupdate":"false","npm":"true","nvm":"true"},"gu":{"id":"%s","host":"%s"}}\\n' "$3" "$configured_host" > "$HOME/.ballin-scripts/ballin.config.json"
    printf '%s\\n' "\\"gu.id\\" set to: \\"$3\\""
    ;;
esac
`, path.join(repoDir, 'bin'));
  };

  const installFakeGhCommand = () => {
    writeExecutable('gh', `#!/usr/bin/env bash
printf 'gh:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
expected_host="\${FAKE_GH_HOST:-github.example.test}"
case "$1:$2" in
  auth:status)
    if [ "$*" != "auth status --hostname $expected_host" ]; then exit 2; fi
    exit "$FAKE_GH_AUTH_STATUS"
    ;;
  gist:view)
    if [ "$GH_HOST" != "$expected_host" ]; then
      printf '%s\\n' 'Unexpected GH_HOST' >&2
      exit 2
    fi
    if [ "$3" = 'returning-gist-id' ] && [ "$4:$5:$6" = '--raw:--filename:.MyConfig.md' ]; then
      printf '%s\\n' '### Backup of your dev environment'
      printf '%s\\n' 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)'
      printf '\\n'
      exit 0
    fi
    if [ "$3" = 'wrong-gist-id' ] && [ "$4:$5:$6" = '--raw:--filename:.MyConfig.md' ]; then
      printf '%s\\n' 'not a ballin backup'
      exit 0
    fi
    if [ "$3" = 'returning-gist-id' ] && [ "$4:$5:$6" = '--raw:--filename:ballin_config' ]; then
      printf '%s\\n' '{"up":{"cleanup":"false","ballin":"true","gu":"true","softwareupdate":"false","npm":"true","nvm":"true"},"gu":{"id":null,"host":"github.example.test"}}'
      exit 0
    fi
    exit 2
    ;;
  gist:create)
    if [ "$GH_HOST" != "$expected_host" ]; then
      printf '%s\\n' 'Unexpected GH_HOST' >&2
      exit 2
    fi
    if [ "$3:$4" != '.MyConfig.md:--desc' ]; then exit 2; fi
    printf '%s\\n' 'https://gist.github.com/new-gist-id'
    ;;
  *) exit 2 ;;
esac
`);
  };

  const runInstall = ({ env = {}, input }: RunInstallOptions = {}) => spawnSync(installPath, [], {
    encoding: 'utf8',
    input,
    env: {
      HOME: homeDir,
      PATH: binDir,
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_NODE_SUPPORTED: 'true',
      FAKE_NODE_STATUS: '0',
      FAKE_GH_AUTH_STATUS: '0',
      ...env,
    },
  });

  const commandLog = () => (fs.existsSync(commandLogPath)
    ? fs.readFileSync(commandLogPath, 'utf8')
    : '');

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-'));
    binDir = path.join(homeDir, '.local', 'bin');
    repoDir = path.join(homeDir, '.ballin-scripts');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'commands'));
    fs.writeFileSync(path.join(repoDir, 'commands', 'install_setup.ts'), '');
    fs.mkdirSync(path.join(repoDir, 'config'));
    fs.copyFileSync(
      path.join(__dirname, '..', 'config', '.defaultConfig.json'),
      path.join(repoDir, 'config', '.defaultConfig.json'),
    );
    commandLogPath = path.join(homeDir, 'commands.log');
    linkCommand('bash');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('stops with guidance when Node.js is unavailable', () => {
    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js is required');
    assert.include(result.stdout, 'Node.js 24.12 or newer with nvm');
    assert.include(result.stdout, 'docs/README.md');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });

  it('stops with guidance when Node.js is below the supported version', () => {
    installBaseCommands();

    const result = runInstall({ env: { FAKE_NODE_SUPPORTED: 'false' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js 24.12 or newer is required');
    assert.include(result.stdout, 'Node.js 24.12 or newer with nvm');
    assert.include(result.stdout, 'docs/README.md');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.equal(commandLog(), '');
  });

  it('stops before configuration and Gist work when the command directory is missing from PATH', () => {
    const pathDir = path.join(homeDir, 'test-path');
    fs.mkdirSync(pathDir);
    ['bash'].forEach((command) => linkCommand(command, pathDir));
    writeExecutable('node', '#!/usr/bin/env bash\nexit 0\n', pathDir);

    const result = runInstall({ env: { PATH: pathDir } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, `${binDir} doesn't seem to be in your path.`);
    assert.include(result.stdout, `export PATH="${binDir}:$PATH"`);
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.equal(commandLog(), '');
  });

  it('stops with guidance when GitHub CLI is unavailable', () => {
    installBaseCommands();
    installAdoptableConfigCommand();

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'GitHub CLI is required for Gist backup setup');
    assert.include(result.stdout, 'Install gh, authenticate it, then run this installer again');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.include(result.stdout, 'docs/README.md');
    assert.notInclude(commandLog(), 'gh:');
    assert.notInclude(result.stdout, 'symlinked binaries');
    assert.notInclude(result.stdout, '😎 ballin!');
    assert.isFalse(fs.existsSync(path.join(binDir, 'ballin_config')));
  });

  it('stops with guidance when GitHub CLI is not authenticated', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();

    const result = runInstall({ env: { FAKE_GH_AUTH_STATUS: '4' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'gh is not authenticated for github.example.test');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.include(result.stdout, 'Then run this installer again');
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:gist');
    assert.notInclude(result.stdout, 'symlinked binaries');
    assert.notInclude(result.stdout, '😎 ballin!');
    assert.isFalse(fs.existsSync(path.join(binDir, 'ballin_config')));
  });

  it('performs an isolated initial setup and shows docs once', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.equal(result.stdout.match(/👀 Docs:/g).length, 1);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
    assert.include(result.stdout, '😎 ballin!');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin_config')).isSymbolicLink());
    assert.include(commandLog(), 'node:install_setup');
    assert.include(commandLog(), 'symlink-binaries');
    assert.notInclude(commandLog(), 'gist:');
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('stops before Gist setup when the typed setup entrypoint is missing from an existing checkout', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();
    fs.unlinkSync(path.join(repoDir, 'commands', 'install_setup.ts'));

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.include(result.stdout, 'Unable to configure Gist backup');
    assert.notInclude(result.stdout, `symlinked binaries into ${binDir}`);
    assert.isFalse(fs.existsSync(path.join(binDir, 'ballin_config')));
    assert.notInclude(commandLog(), 'node:install_setup');
  });

  it('falls back to Bash config setup when the typed setup entrypoint does not support configure yet', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();
    writeExecutable('node', `#!/usr/bin/env bash
if [ "$1" = '-p' ]; then
  printf '%s\\n' "$FAKE_NODE_SUPPORTED"
  exit 0
fi
if [ "$1" = "$HOME/.ballin-scripts/commands/install_setup.ts" ]; then
  printf 'node:install_setup %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
  shift
  if [ "$1" = 'symlink-binaries' ]; then
    repo_dir="$2"
    bin_dir="$3"
    mkdir -p "$bin_dir"
    for bin in "$repo_dir/bin/"*; do
      ln -sfn "$bin" "$bin_dir/\${bin##*/}"
    done
    printf '\\n💪 symlinked binaries into %s\\n' "$bin_dir"
    exit 0
  fi
  exit 1
fi
printf '%s' "$FAKE_UPDATE_OUTPUT"
exit "$FAKE_NODE_STATUS"
`);

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
    assert.include(commandLog(), 'node:install_setup');
    assert.include(result.stdout, 'Unable to configure Gist backup');
    assert.notInclude(result.stdout, `symlinked binaries into ${binDir}`);
  });

  it('does not repeat unchanged setup guidance during an ordinary update', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, '👀 Docs:');
    assert.notInclude(result.stdout, "Created 'ballin.config.json'");
    assert.notInclude(result.stdout, 'What GitHub host should be used for Gist backups?');
    assert.include(result.stdout, '😎 ballin!');
  });

  it('prompts once when migration adds gu.host to an existing Gist config', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();
    fs.writeFileSync(path.join(homeDir, '.configured-gist-id'), 'existing-gist-id\n');
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{"gu":{"id":"existing-gist-id"}}\n');

    const result = runInstall({
      env: {
        FAKE_GH_HOST: 'github.enterprise.test',
        FAKE_UPDATE_OUTPUT: 'New configuration options have been added!\ngu.host: github.example.test\n',
      },
      input: 'github.enterprise.test\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'ballin_config:set gu.host github.enterprise.test\n');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('reports newly added configuration and links to the guide', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');

    const updateOutput = 'New configuration options have been added!\nup.nvm: false\n';
    const result = runInstall({ env: { FAKE_UPDATE_OUTPUT: updateOutput } });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, updateOutput.trim());
    assert.equal(result.stdout.match(/👀 Docs:/g).length, 1);
    assert.include(result.stdout, 'docs/README.md');
    assert.include(commandLog(), 'configure');
  });

  it('restores config values from an adopted backup gist', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();

    const result = runInstall({ input: '\ny\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Storing your previous gist ID in your config');
    assert.include(result.stdout, 'Restored ballin.config.json from your backup gist');
    assert.include(commandLog(), 'gh:gist view returning-gist-id --raw --filename ballin_config');
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
    const restoredConfig = JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'));
    assert.equal(restoredConfig.up.cleanup, 'false');
    assert.equal(restoredConfig.up.gu, 'true');
    assert.equal(restoredConfig.gu.id, 'returning-gist-id');
    assert.equal(restoredConfig.gu.host, 'github.example.test');
  });

  it('rejects readable returning Gists without the backup marker', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();

    const result = runInstall({ input: '\ny\nwrong-gist-id\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "INVALID: Expected backup marker in gist 'wrong-gist-id'");
    assert.include(commandLog(), 'gh:gist view wrong-gist-id --raw --filename .MyConfig.md');
    assert.notInclude(commandLog(), 'ballin_config:set gu.id wrong-gist-id');
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
  });

  it('stops before Gist and success output when config creation fails', () => {
    installBaseCommands();
    installConfigCommand();
    fs.unlinkSync(path.join(binDir, 'cp'));
    writeExecutable('cp', '#!/usr/bin/env bash\nexit 9\n');

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to create or update ballin.config.json');
    assert.notInclude(commandLog(), 'ballin_config:');
    assert.notInclude(commandLog(), 'gist:');
    assert.notInclude(result.stdout, 'symlinked binaries');
    assert.notInclude(result.stdout, '😎 ballin!');
  });

  it('stops before Gist and success output when config migration fails', () => {
    installBaseCommands();
    installConfigCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');

    const result = runInstall({ env: { FAKE_NODE_STATUS: '7' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to create or update ballin.config.json');
    assert.notInclude(commandLog(), 'ballin_config:');
    assert.notInclude(commandLog(), 'gist:');
    assert.notInclude(result.stdout, 'symlinked binaries');
    assert.notInclude(result.stdout, '😎 ballin!');
  });

  it('uses the Homebrew prefix as the command directory when brew is present', () => {
    installBaseCommands();
    installConfigCommand();
    installFakeGhCommand();
    writeExecutable('brew', `#!/usr/bin/env bash
if [ "$1" = '--prefix' ]; then
  printf '%s\\n' "$HOME/.local"
  exit 0
fi
exit 2
`);

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
  });

  it('creates a new secret Gist when gh is authenticated and no backup is configured', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();

    const result = runInstall({ input: '\nn\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created a secret gist titled '.MyConfig'");
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    assert.include(commandLog(), 'ballin_config:set gu.id new-gist-id\n');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.MyConfig.md')));
  });

  it('uses an install-time custom Gist host from user input', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    installFakeGhCommand();

    const result = runInstall({
      env: { FAKE_GH_HOST: 'github.enterprise.test' },
      input: 'github.enterprise.test\nn\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'ballin_config:set gu.host github.enterprise.test\n');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    const configuredHost = fs.readFileSync(path.join(homeDir, '.configured-gu-host'), 'utf8').trim();
    assert.equal(configuredHost, 'github.enterprise.test');
    const createdConfig = JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'));
    assert.equal(createdConfig.gu.host, 'github.enterprise.test');
    assert.equal(createdConfig.gu.id, 'new-gist-id');
  });
});
