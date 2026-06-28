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
case "$1:$2" in
  get:gu.host) printf '%s\\n' 'github.example.test' ;;
  get:gu.id)
    if [ -f "$gist_id_file" ]; then
      while IFS= read -r gist_id; do
        printf '%s\\n' "$gist_id"
      done < "$gist_id_file"
    else
      printf '%s\\n' 'null'
    fi
    ;;
  set:gu.id)
    printf '%s\\n' "$3" > "$gist_id_file"
    printf '{"up":{"cleanup":"false","ballin":"true","gu":"true","softwareupdate":"false","npm":"true","nvm":"true"},"gu":{"id":"%s","host":"github.example.test"}}\\n' "$3" > "$HOME/.ballin-scripts/ballin.config.json"
    printf '%s\\n' "\\"gu.id\\" set to: \\"$3\\""
    ;;
esac
`, path.join(repoDir, 'bin'));
  };

  const installFakeGhCommand = () => {
    writeExecutable('gh', `#!/usr/bin/env bash
printf 'gh:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  auth:status)
    if [ "$*" != 'auth status --hostname github.example.test' ]; then exit 2; fi
    exit "$FAKE_GH_AUTH_STATUS"
    ;;
  gist:view)
    if [ "$GH_HOST" != 'github.example.test' ]; then
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
    if [ "$GH_HOST" != 'github.example.test' ]; then
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

  it('succeeds without Homebrew, gist, or gh when Gist backup is unconfigured', () => {
    installBaseCommands();
    installAdoptableConfigCommand();

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Skipping optional Gist backup setup because GitHub CLI is not installed');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.include(result.stdout, '😎 ballin!');
    assert.notInclude(commandLog(), 'gh:');
  });

  it('performs an isolated initial setup and shows docs once', () => {
    installBaseCommands();
    installConfigCommand();

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
    assert.notInclude(commandLog(), 'gh:');
  });

  it('falls back to Bash symlinking when the typed setup entrypoint is missing from an existing checkout', () => {
    installBaseCommands();
    installConfigCommand();
    fs.unlinkSync(path.join(repoDir, 'commands', 'install_setup.ts'));

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin_config')).isSymbolicLink());
    assert.notInclude(commandLog(), 'node:install_setup');
  });

  it('falls back to Bash config setup when the typed setup entrypoint does not support configure yet', () => {
    installBaseCommands();
    installConfigCommand();
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

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
    assert.include(commandLog(), 'node:install_setup');
  });

  it('does not repeat unchanged setup guidance during an ordinary update', () => {
    installBaseCommands();
    installConfigCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, '👀 Docs:');
    assert.notInclude(result.stdout, "Created 'ballin.config.json'");
    assert.include(result.stdout, '😎 ballin!');
  });

  it('reports newly added configuration and links to the guide', () => {
    installBaseCommands();
    installConfigCommand();
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

    const result = runInstall({ input: 'y\nreturning-gist-id\n' });

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

    const result = runInstall({ input: 'y\nwrong-gist-id\nreturning-gist-id\n' });

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

    const result = runInstall({ input: 'n\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created a secret gist titled '.MyConfig'");
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    assert.include(commandLog(), 'ballin_config:set gu.id new-gist-id\n');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.MyConfig.md')));
  });
});
