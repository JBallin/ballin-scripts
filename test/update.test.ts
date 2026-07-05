const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type InstallCommandStubOptions = {
  output?: string;
  status?: number;
  directory?: string;
};

describe('ballin update', () => {
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
printf '%s|%s|%s\\n' "${name}" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-update-'));
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(tempDir, 'ballin.config.json');
    logPath = path.join(tempDir, 'commands.log');
    fs.mkdirSync(binDir);
    fs.symlinkSync('/bin/bash', path.join(binDir, 'bash'));
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'true',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'false',
        backup: 'false',
      },
      backup: {
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

  const writeUpdateConfig = (env: NodeJS.ProcessEnv = {}) => {
    writeConfig({
      update: {
        cleanup: env.TEST_UPDATE_CLEANUP ?? 'false',
        nvm: env.TEST_UPDATE_NVM ?? 'true',
        npm: env.TEST_UPDATE_NPM ?? 'false',
        softwareupdate: env.TEST_UPDATE_SOFTWAREUPDATE ?? 'false',
        selfUpdate: env.TEST_UPDATE_BALLIN ?? 'false',
        backup: env.TEST_UPDATE_BACKUP ?? 'false',
      },
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });
  };

  const runUpdate = (env: NodeJS.ProcessEnv = {}) => {
    writeUpdateConfig(env);
    return spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        NVM_TEST_LOG: logPath,
        UPDATE_TEST_LOG: logPath,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
        BALLIN_TEST_BALLIN_PATH: path.join(binDir, 'ballin'),
        ...env,
      },
    });
  };

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
    const symlinkPath = path.join(installBinDir, 'ballin');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(ballinPath, symlinkPath);
    writeUpdateConfig({ TEST_UPDATE_NVM: 'false' });

    const result = spawnSync(symlinkPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
        UPDATE_TEST_LOG: logPath,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('sets Homebrew flags, preserves output, cleans conditionally, and runs doctor', () => {
    installCommandStub('brew', { output: 'visible Homebrew output' });

    const result = runUpdate({ TEST_UPDATE_NVM: 'false', TEST_UPDATE_CLEANUP: 'true' });

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
printf 'brew|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = 'cleanup' ]; then
  printf '%s\\n' 'simulated cleanup failure'
  exit 42
fi
exit 0
`);
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_CLEANUP: 'true',
      TEST_UPDATE_BALLIN: 'true',
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
      'ballin|1,1|self-update',
      'gh|1,1|auth status --hostname example.test',
    ]);
  });

  it('passes exported Homebrew flags to later integrations', () => {
    installCommandStub('brew');
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
      'ballin|1,1|self-update',
      'gh|1,1|auth status --hostname example.test',
    ]);
  });

  it('skips cleanup when disabled while preserving upgrade and doctor output', () => {
    installCommandStub('brew', { output: 'brew command output' });

    const result = runUpdate({ TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Cleaning up Homebrew packages');
    assert.deepEqual(commandLog(), [
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
    ]);
    assert.equal(result.stdout.match(/brew command output/g).length, 2);
  });

  it('runs enabled npm, macOS update, ballin update, and backup integrations', () => {
    ['npm', 'softwareupdate'].forEach((command) => {
      installCommandStub(command);
    });
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_NPM: 'true',
      TEST_UPDATE_SOFTWAREUPDATE: 'true',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'softwareupdate|,|-ia',
      'ballin|,|self-update',
      'gh|,|auth status --hostname example.test',
      'ballin|,|backup',
    ]);
  });

  it('checks Ballin readiness after a successful ballin update', () => {
    installCommandStub('ballin', { output: 'updated ballin-scripts' });
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.include(result.stdout, 'updated ballin-scripts');
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('checks Ballin readiness with the Node.js runtime from the updated nvm PATH', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    writeTestExecutable('node', `#!/usr/bin/env bash
printf 'node|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
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

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog().slice(1), [
      'node|,|-e process.stdout.write(JSON.stringify(process.env))',
      'ballin|,|self-update',
      'node|,|-p process.versions.node',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('keeps Ballin readiness failures informational after update', () => {
    const selfUpdatePath = path.join(tempDir, 'self-update-ballin');
    fs.writeFileSync(selfUpdatePath, `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "ballin" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
exit 0
`, { mode: 0o755 });
    installHealthyReadinessCommands();
    fs.rmSync(path.join(binDir, 'ballin'));

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
      BALLIN_TEST_BALLIN_PATH: selfUpdatePath,
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: ballin.');
    assert.include(result.stdout, 'Next: Run the installer again or add the Ballin command directory to PATH.');
    assert.notInclude(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --hostname example.test',
    ]);
  });

  it('skips Ballin readiness when ballin update fails', () => {
    installCommandStub('ballin', { output: 'simulated update failure', status: 23 });
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated update failure');
    assert.notInclude(result.stdout, 'Checking Ballin readiness');
    assert.notInclude(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
    ]);
  });

  it('does not run disabled optional integrations even when commands exist', () => {
    ['npm', 'softwareupdate', 'ballin'].forEach((command) => {
      installCommandStub(command);
    });

    const result = runUpdate({ TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), []);
    assert.notInclude(result.stdout, 'Updating global npm packages');
    assert.notInclude(result.stdout, 'Installing macOS updates');
    assert.notInclude(result.stdout, 'Updating ballin-scripts');
    assert.notInclude(result.stdout, 'Backing up development environment');
  });

  it('keeps later integrations isolated when an optional command fails', () => {
    installCommandStub('npm', { output: 'simulated npm failure', status: 23 });
    installCommandStub('ballin');
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_NPM: 'true',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated npm failure');
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'ballin|,|self-update',
      'gh|,|auth status --hostname example.test',
      'ballin|,|backup',
    ]);
  });

  it('still uses final backup status after informational Ballin readiness', () => {
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "ballin" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = 'backup' ]; then
  printf '%s\\n' 'simulated backup failure'
  exit 17
fi
exit 0
`);
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'Your Ballin-managed environment is healthy.');
    assert.include(result.stdout, 'simulated backup failure');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --hostname example.test',
      'ballin|,|backup',
    ]);
  });

  it('uses backup as the final exit status when backup is enabled', () => {
    installCommandStub('ballin', { output: 'simulated backup failure', status: 17 });

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'simulated backup failure');
    assert.deepEqual(commandLog(), [
      'ballin|,|backup',
    ]);
  });

  it('uses a shell-style signal exit status for final backup', () => {
    writeTestExecutable('ballin', `#!/usr/bin/env bash
kill -TERM "$$"
`);

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 143);
    assert.include(result.stdout, 'Backing up development environment');
  });

  it('loads nvm from NVM_DIR and updates Node.js LTS', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUpdate({ NVM_DIR: nvmDir });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'install --lts\n');
  });

  it('reports nvm install failures after running later integrations', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
  return 24
}
`,
    );
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' 'backup still ran' >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 24);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      'backup still ran',
    ]);
  });

  it('keeps nvm PATH changes for the npm update', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_NPM: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stdout, 'Updating global npm packages');
    assert.equal(fs.readFileSync(logPath, 'utf8').split('\n')[0], 'install --lts');
    assert.deepEqual(commandLog().slice(1), [
      'npm|,|update -g',
    ]);
  });

  it('keeps nvm PATH changes for later backups', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    const nvmNpmPath = path.join(nvmBinDir, 'npm');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });
    writeTestExecutable('ballin', `#!/usr/bin/env bash
if [ "$*" != 'backup' ]; then exit 2; fi
printf 'backup-npm|%s\\n' "$(command -v npm)" >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      `backup-npm|${nvmNpmPath}`,
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
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' 'backup still ran' >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      'backup still ran',
    ]);
  });

  it('warns when nvm is enabled but cannot be loaded', () => {
    const result = runUpdate();

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stderr, 'unable to load nvm');
    assert.include(result.stderr, 'Set NVM_DIR');
    assert.include(result.stderr, 'ballin config set update.nvm false');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('does not load nvm when the integration is disabled', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUpdate({ NVM_DIR: nvmDir, TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Updating Node.js LTS');
    assert.notInclude(result.stderr, 'unable to load nvm');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('surfaces config read failures', () => {
    fs.writeFileSync(configPath, '{not json\n');

    const result = spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
      },
    });

    assert.equal(result.status, 0);
    assert.isNotEmpty(result.stderr);
    assert.deepEqual(commandLog(), []);
  });

  it('reports missing config reads', () => {
    fs.rmSync(configPath);

    const result = spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
      },
    });

    assert.equal(result.status, 0);
    assert.include(result.stderr, 'Unable to read');
    assert.deepEqual(commandLog(), []);
  });
});
