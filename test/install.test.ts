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
printf '%s' "$FAKE_UPDATE_OUTPUT"
exit "$FAKE_NODE_STATUS"
`);
    writeExecutable('gist', `#!/usr/bin/env bash
printf 'gist:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
exit 0
`);
  };

  const installConfigCommand = () => {
    writeExecutable('ballin_config', `#!/usr/bin/env bash
printf 'ballin_config:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  get:gu.token_file) printf '%s\\n' '.gist' ;;
  get:gu.url) printf '%s\\n' 'https://gist.example.test' ;;
  get:gu.id) printf '%s\\n' 'existing-gist-id' ;;
esac
`, path.join(repoDir, 'bin'));
  };

  const installAdoptableConfigCommand = () => {
    writeExecutable('ballin_config', `#!/usr/bin/env bash
printf 'ballin_config:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
gist_id_file="$HOME/.configured-gist-id"
case "$1:$2" in
  get:gu.token_file) printf '%s\\n' '.gist' ;;
  get:gu.url) printf '%s\\n' 'https://gist.example.test' ;;
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
    printf '%s\\n' "\\"gu.id\\" set to: \\"$3\\""
    ;;
esac
`, path.join(repoDir, 'bin'));
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
    assert.include(result.stdout, 'docs/optional-capabilities.md');
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
    assert.include(result.stdout, 'docs/optional-capabilities.md');
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
    writeExecutable('gist', `#!/usr/bin/env bash
printf '%s\\n' gist >> "$FAKE_COMMAND_LOG"
`, pathDir);

    const result = runInstall({ env: { PATH: pathDir } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, `${binDir} doesn't seem to be in your path.`);
    assert.include(result.stdout, `export PATH="${binDir}:$PATH"`);
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.equal(commandLog(), '');
  });

  it('checks the Gist prerequisite before configuration work', () => {
    installBaseCommands();
    fs.unlinkSync(path.join(binDir, 'gist'));

    const result = runInstall();

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Can't find Homebrew, which is needed to download 'gist'.");
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.equal(commandLog(), '');
  });

  it('performs an isolated initial setup and shows optional capabilities once', () => {
    installBaseCommands();
    installConfigCommand();
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.equal(result.stdout.match(/👀 Optional capabilities:/g).length, 1);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
    assert.include(result.stdout, '😎 ballin!');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin_config')).isSymbolicLink());
    assert.include(commandLog(), 'gist:-l\n');
  });

  it('does not repeat unchanged setup guidance during an ordinary update', () => {
    installBaseCommands();
    installConfigCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, '👀 Optional capabilities:');
    assert.notInclude(result.stdout, "Created 'ballin.config.json'");
    assert.include(result.stdout, '😎 ballin!');
  });

  it('reports newly added configuration and links to the guide', () => {
    installBaseCommands();
    installConfigCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');

    const updateOutput = 'New configuration options have been added!\nup.nvm: false\n';
    const result = runInstall({ env: { FAKE_UPDATE_OUTPUT: updateOutput } });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, updateOutput.trim());
    assert.equal(result.stdout.match(/👀 Optional capabilities:/g).length, 1);
    assert.include(result.stdout, 'docs/optional-capabilities.md');
  });

  it('adopts an existing backup gist without restoring remote config values', () => {
    installBaseCommands();
    installAdoptableConfigCommand();
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');
    writeExecutable('gist', `#!/usr/bin/env bash
printf 'gist:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  -l:) exit 0 ;;
  -r:returning-gist-id)
    if [ "$3" = 'ballin_config' ]; then
      printf '%s\\n' 'remote config should not be restored' >&2
      exit 3
    fi
    printf '%s\\n' '### Backup of your dev environment'
    printf '%s\\n' 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)'
    printf '\\n'
    ;;
esac
`);

    const result = runInstall({ input: 'y\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Storing your previous gist ID in your config');
    assert.include(result.stdout, 'Keeping your local ballin.config.json settings');
    assert.include(result.stdout, 'only the backup gist ID was adopted');
    assert.notInclude(commandLog(), 'gist:-r returning-gist-id ballin_config');
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
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
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');
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

  it('installs a missing Gist dependency through the Homebrew stub', () => {
    installBaseCommands();
    installConfigCommand();
    fs.unlinkSync(path.join(binDir, 'gist'));
    fs.writeFileSync(path.join(homeDir, '.gist'), 'token\n');
    writeExecutable('brew', `#!/usr/bin/env bash
if [ "$1" = '--prefix' ]; then
  printf '%s\\n' "$HOME/.local"
elif [ "$1:$2" = 'install:gist' ]; then
  printf '%s\\n' '#!/usr/bin/env bash' 'printf "gist:%s\\\\n" "$*" >> "$FAKE_COMMAND_LOG"' > "$HOME/.local/bin/gist"
  chmod +x "$HOME/.local/bin/gist"
  printf '%s\\n' 'brew:install gist' >> "$FAKE_COMMAND_LOG"
else
  exit 2
fi
`);

    const result = runInstall();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'brew installing gist');
    assert.include(commandLog(), 'brew:install gist\n');
    assert.include(commandLog(), 'gist:-l\n');
  });
});
