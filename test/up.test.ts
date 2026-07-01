const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');

const upPath = path.join(__dirname, '..', 'bin', 'up');
type InstallCommandStubOptions = {
  output?: string;
  status?: number;
  directory?: string;
};

describe('up', () => {
  let tempDir: string;
  let binDir: string;
  let configPath: string;
  let logPath: string;

  const writeTestExecutable = (name: string, contents: string, directory = binDir) => {
    fs.writeFileSync(path.join(directory, name), contents, { mode: 0o755 });
  };

  const installCommandStub = (
    name: string,
    { output = '', status = 0, directory = binDir }: InstallCommandStubOptions = {},
  ) => {
    fs.writeFileSync(path.join(directory, name), `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "${name}" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UP_TEST_LOG"
${output ? `printf '%s\\n' '${output}'` : ''}
exit ${status}
`, { mode: 0o755 });
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const installHealthyReadinessCommands = () => {
    requiredCommandShims.forEach((command: string) => {
      if (!fs.existsSync(path.join(binDir, command))) {
        installCommandStub(command);
      }
    });
    installCommandStub('gh');
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-up-'));
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(tempDir, 'ballin.config.json');
    logPath = path.join(tempDir, 'commands.log');
    fs.mkdirSync(binDir);
    fs.symlinkSync('/bin/bash', path.join(binDir, 'bash'));
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
case "$2" in
  up.cleanup) printf '%s\\n' "\${TEST_UP_CLEANUP:-false}" ;;
  up.nvm) printf '%s\\n' "\${TEST_UP_NVM:-false}" ;;
  up.npm) printf '%s\\n' "\${TEST_UP_NPM:-false}" ;;
  up.softwareupdate) printf '%s\\n' "\${TEST_UP_SOFTWAREUPDATE:-false}" ;;
  up.ballin) printf '%s\\n' "\${TEST_UP_BALLIN:-false}" ;;
  up.gu) printf '%s\\n' "\${TEST_UP_GU:-false}" ;;
  *) printf '%s\\n' 'false' ;;
esac
`);
    writeConfig({
      up: {},
      gu: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const runUp = (env: NodeJS.ProcessEnv = {}) => spawnSync(upPath, [], {
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: binDir,
      NVM_TEST_LOG: logPath,
      UP_TEST_LOG: logPath,
      BALLIN_TEST_CONFIG_PATH: configPath,
      TEST_UP_NVM: 'true',
      ...env,
    },
  });

  const installNvmStub = (nvmDir: string) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
}
`,
    );
  };

  const installPathUpdatingNvmStub = (nvmDir: string, nvmBinDir: string) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
  export PATH="${nvmBinDir}:$PATH"
}
`,
    );
  };

  const commandLog = () => (
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
  );

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(tempDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'up');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(upPath, symlinkPath);

    const result = spawnSync(symlinkPath, [], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        TEST_UP_NVM: 'false',
        UP_TEST_LOG: logPath,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('sets Homebrew flags, preserves output, cleans conditionally, and runs doctor', () => {
    installCommandStub('brew', { output: 'visible Homebrew output' });

    const result = runUp({ TEST_UP_NVM: 'false', TEST_UP_CLEANUP: 'true' });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'visible Homebrew output');
    assert.include(result.stdout, 'Cleaning up Homebrew packages');
    assert.include(result.stdout, 'Checking Homebrew installation');
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|cleanup',
      'brew|1,1|doctor',
    ]);
  });

  it('reports a Homebrew substep failure after running later integrations', () => {
    writeTestExecutable('brew', `#!/usr/bin/env bash
printf 'brew|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UP_TEST_LOG"
if [ "$1" = 'cleanup' ]; then
  printf '%s\\n' 'simulated cleanup failure'
  exit 42
fi
exit 0
`);
    installCommandStub('ballin_update');
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_CLEANUP: 'true',
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 42);
    assert.include(result.stdout, 'simulated cleanup failure');
    assert.include(result.stdout, 'Checking Homebrew installation');
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|cleanup',
      'brew|1,1|doctor',
      'ballin_update|1,1|',
      'gh|1,1|auth status --hostname example.test',
    ]);
  });

  it('passes exported Homebrew flags to later integrations', () => {
    installCommandStub('brew');
    installCommandStub('ballin_update');
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
      'ballin_update|1,1|',
      'gh|1,1|auth status --hostname example.test',
    ]);
  });

  it('skips cleanup when disabled while preserving upgrade and doctor output', () => {
    installCommandStub('brew', { output: 'brew command output' });

    const result = runUp({ TEST_UP_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Cleaning up Homebrew packages');
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
    ]);
    assert.equal(result.stdout.match(/brew command output/g).length, 2);
  });

  it('runs enabled npm, macOS update, ballin update, and gu integrations', () => {
    ['npm', 'softwareupdate', 'ballin_update', 'gu'].forEach((command) => {
      installCommandStub(command);
    });
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_NPM: 'true',
      TEST_UP_SOFTWAREUPDATE: 'true',
      TEST_UP_BALLIN: 'true',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'softwareupdate|,|-ia',
      'ballin_update|,|',
      'gh|,|auth status --hostname example.test',
      'gu|,|',
    ]);
  });

  it('checks Ballin readiness after a successful ballin update', () => {
    installCommandStub('ballin_update', { output: 'updated ballin-scripts' });
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.include(result.stdout, 'updated ballin-scripts');
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin_update|,|',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('checks Ballin readiness with the Node.js runtime from the updated nvm PATH', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    writeTestExecutable('node', `#!/usr/bin/env bash
printf 'node|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UP_TEST_LOG"
if [ "$*" = '-p process.versions.node' ]; then
  printf '%s\\n' '99.0.0'
  exit 0
fi
if [ "$1" = '-e' ]; then
  ${JSON.stringify(process.execPath)} -e "$2"
  exit "$?"
fi
exit 2
`, nvmBinDir);
    installHealthyReadinessCommands();

    const result = runUp({
      NVM_DIR: nvmDir,
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog().slice(1), [
      'node|,|-e process.stdout.write(JSON.stringify(process.env))',
      'ballin_update|,|',
      'node|,|-p process.versions.node',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('keeps Ballin readiness failures informational after update', () => {
    installCommandStub('ballin_update');
    installHealthyReadinessCommands();
    fs.rmSync(path.join(binDir, 'up'));

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: up.');
    assert.include(result.stdout, 'Next: Run the installer again or add the Ballin command directory to PATH.');
    assert.notInclude(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin_update|,|',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('skips Ballin readiness when ballin update fails', () => {
    installCommandStub('ballin_update', { output: 'simulated update failure', status: 23 });
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_BALLIN: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated update failure');
    assert.notInclude(result.stdout, 'Checking Ballin readiness');
    assert.notInclude(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin_update|,|',
    ]);
  });

  it('does not run disabled optional integrations even when commands exist', () => {
    ['npm', 'softwareupdate', 'ballin_update', 'gu'].forEach((command) => {
      installCommandStub(command);
    });

    const result = runUp({ TEST_UP_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), []);
    assert.notInclude(result.stdout, 'Updating global npm packages');
    assert.notInclude(result.stdout, 'Installing macOS updates');
    assert.notInclude(result.stdout, 'Updating ballin-scripts');
    assert.notInclude(result.stdout, 'Backing up development environment');
  });

  it('keeps later integrations isolated when an optional command fails', () => {
    installCommandStub('npm', { output: 'simulated npm failure', status: 23 });
    installCommandStub('ballin_update');
    installCommandStub('gu');
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_NPM: 'true',
      TEST_UP_BALLIN: 'true',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated npm failure');
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'ballin_update|,|',
      'gh|,|auth status --hostname example.test',
      'gu|,|',
    ]);
  });

  it('still uses final gu status after informational Ballin readiness', () => {
    installCommandStub('ballin_update');
    installCommandStub('gu', { output: 'simulated gu failure', status: 17 });
    installHealthyReadinessCommands();

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_BALLIN: 'true',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.include(result.stdout, 'simulated gu failure');
    assert.deepEqual(commandLog(), [
      'ballin_update|,|',
      'gh|,|auth status --hostname example.test',
      'gu|,|',
    ]);
  });

  it('uses gu as the final exit status when gu is enabled', () => {
    installCommandStub('gu', { output: 'simulated gu failure', status: 17 });

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'simulated gu failure');
    assert.deepEqual(commandLog(), [
      'gu|,|',
    ]);
  });

  it('uses a shell-style signal exit status for final gu', () => {
    writeTestExecutable('gu', `#!/usr/bin/env bash
kill -TERM "$$"
`);

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 143);
    assert.include(result.stdout, 'Backing up development environment');
  });

  it('reports missing unguarded integrations like the shell did', () => {
    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 127);
    assert.include(result.stdout, 'Backing up development environment');
    assert.include(result.stderr, 'gu: command not found');
    assert.deepEqual(commandLog(), []);
  });

  it('reports permission-denied unguarded integrations like the shell did', () => {
    fs.writeFileSync(path.join(binDir, 'gu'), '#!/usr/bin/env bash\n', { mode: 0o644 });

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 126);
    assert.include(result.stdout, 'Backing up development environment');
    assert.include(result.stderr, 'gu: Permission denied');
    assert.deepEqual(commandLog(), []);
  });

  it('loads nvm from NVM_DIR and updates Node.js LTS', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUp({ NVM_DIR: nvmDir });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'install --lts\n');
  });

  it('keeps nvm PATH changes for the npm update', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });

    const result = runUp({
      NVM_DIR: nvmDir,
      TEST_UP_NPM: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stdout, 'Updating global npm packages');
    assert.equal(fs.readFileSync(logPath, 'utf8').split('\n')[0], 'install --lts');
    assert.deepEqual(commandLog().slice(1), [
      'npm|,|update -g',
    ]);
  });

  it('keeps nvm PATH changes for later gu backups', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    const nvmNpmPath = path.join(nvmBinDir, 'npm');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });
    writeTestExecutable('gu', `#!/usr/bin/env bash
printf 'gu-npm|%s\\n' "$(command -v npm)" >> "$UP_TEST_LOG"
`);

    const result = runUp({
      NVM_DIR: nvmDir,
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      `gu-npm|${nvmNpmPath}`,
    ]);
  });

  it('keeps running later integrations when nvm env capture fails', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const brokenNodeDir = path.join(tempDir, 'broken-node');
    fs.mkdirSync(brokenNodeDir);
    installPathUpdatingNvmStub(nvmDir, brokenNodeDir);
    fs.writeFileSync(path.join(brokenNodeDir, 'node'), `#!/usr/bin/env bash
exit 42
`, { mode: 0o755 });
    writeTestExecutable('gu', `#!/usr/bin/env bash
printf '%s\\n' 'gu still ran' >> "$UP_TEST_LOG"
`);

    const result = runUp({
      NVM_DIR: nvmDir,
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      'gu still ran',
    ]);
  });

  it('warns when nvm is enabled but cannot be loaded', () => {
    const result = runUp();

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stderr, 'unable to load nvm');
    assert.include(result.stderr, 'Set NVM_DIR');
    assert.include(result.stderr, 'ballin_config set up.nvm false');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('does not load nvm when the integration is disabled', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUp({ NVM_DIR: nvmDir, TEST_UP_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Updating Node.js LTS');
    assert.notInclude(result.stderr, 'unable to load nvm');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('surfaces ballin_config stderr when config reads fail', () => {
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
printf '%s\\n' 'broken config' >&2
exit 42
`);

    const result = runUp();

    assert.equal(result.status, 0);
    assert.include(result.stderr, 'broken config');
    assert.deepEqual(commandLog(), []);
  });

  it('reports missing ballin_config reads like the shell did', () => {
    fs.rmSync(path.join(binDir, 'ballin_config'));

    const result = runUp();

    assert.equal(result.status, 0);
    assert.include(result.stderr, 'ballin_config: command not found');
    assert.deepEqual(commandLog(), []);
  });
});
