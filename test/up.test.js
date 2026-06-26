const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const upPath = path.join(__dirname, '..', 'bin', 'up');

describe('up', () => {
  let tempDir;
  let binDir;
  let logPath;

  const writeTestExecutable = (name, contents) => {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  };

  const installCommandStub = (name, { output = '', status = 0 } = {}) => {
    writeTestExecutable(name, `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "${name}" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UP_TEST_LOG"
${output ? `printf '%s\\n' '${output}'` : ''}
exit ${status}
`);
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-up-'));
    binDir = path.join(tempDir, 'bin');
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
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const runUp = (env = {}) => spawnSync(upPath, [], {
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: binDir,
      NVM_TEST_LOG: logPath,
      UP_TEST_LOG: logPath,
      TEST_UP_NVM: 'true',
      ...env,
    },
  });

  const installNvmStub = (nvmDir) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
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
      'gu|,|',
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

    const result = runUp({
      TEST_UP_NVM: 'false',
      TEST_UP_NPM: 'true',
      TEST_UP_BALLIN: 'true',
      TEST_UP_GU: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'simulated npm failure');
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'ballin_update|,|',
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

  it('loads nvm from NVM_DIR and updates Node.js LTS', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUp({ NVM_DIR: nvmDir });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'install --lts\n');
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
});
