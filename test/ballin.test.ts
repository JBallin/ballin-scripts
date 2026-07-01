const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type StringSpawnResult = import('child_process').SpawnSyncReturns<string>;

describe('ballin', () => {
  let tempDir: string;
  let binDir: string;
  let configPath: string;
  let commandLogPath: string;

  const assertHelpOutput = (result: StringSpawnResult) => {
    assert.equal(result.status, 0);
    assert.include(result.stdout, 'A Collection of Ballin Scripts!');
    assert.include(result.stdout, 'ballin doctor');
    assert.include(result.stdout, '--verbose');
    assert.include(result.stdout, 'ballin_update');
    assert.include(result.stdout, 'ballin_config');
    assert.include(result.stdout, 'ballin_uninstall');
    assert.include(result.stdout, 'gu');
    assert.include(result.stdout, 'up');
    assert.equal(result.stderr, '');
  };

  const writeExecutable = (name: string, contents = '#!/bin/bash\nexit 0\n') => {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const runBallin = (args: string[] = []): StringSpawnResult => spawnSync(process.execPath, [
    ballinPath,
    ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BALLIN_NO_ANALYTICS: '1',
      BALLIN_TEST_CONFIG_PATH: configPath,
      FAKE_COMMAND_LOG: commandLogPath,
      PATH: binDir,
    },
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-doctor-'));
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(tempDir, 'ballin.config.json');
    commandLogPath = path.join(tempDir, 'commands.log');

    fs.mkdirSync(binDir, { recursive: true });
    requiredCommandShims.forEach((command: string) => writeExecutable(command));
    writeExecutable('gh', `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  auth:status)
    if [ "$*" != "auth status --hostname example.test" ]; then exit 2; fi
    exit "\${FAKE_GH_AUTH_STATUS:-0}"
    ;;
  *) exit 2 ;;
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

  it('remains executable through its shebang', () => {
    assertHelpOutput(spawnSync(ballinPath, [], {
      encoding: 'utf8',
      env: process.env,
    }));
  });

  it('remains executable through the installed symlink model', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-bin-'));
    const symlinkPath = path.join(tempDir, 'ballin');

    try {
      fs.symlinkSync(ballinPath, symlinkPath);
      assertHelpOutput(spawnSync(symlinkPath, [], {
        encoding: 'utf8',
        env: process.env,
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a concise healthy doctor result by default', () => {
    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Your Ballin-managed environment is healthy.\n');
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(commandLogPath, 'utf8'), 'auth status --hostname example.test\n');
  });

  it('reports full Ballin-managed environment checks through verbose doctor', () => {
    const result = runBallin(['doctor', '--verbose']);

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Ballin doctor');
    assert.include(result.stdout, 'OK    Node.js runtime:');
    assert.include(result.stdout, 'OK    Command shims on PATH:');
    assert.include(result.stdout, 'OK    Config readability:');
    assert.include(result.stdout, 'OK    Gist host:');
    assert.include(result.stdout, 'OK    Gist ID:');
    assert.include(result.stdout, 'OK    GitHub CLI:');
    assert.include(result.stdout, 'OK    GitHub CLI authentication:');
    assert.include(result.stdout, 'Result: Ballin-managed environment health looks good.');
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(commandLogPath, 'utf8'), 'auth status --hostname example.test\n');
  });

  it('reports doctor warnings without failing the command', () => {
    fs.rmSync(path.join(binDir, 'gh'));
    writeConfig({
      up: {},
      gu: {
        id: null,
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });

    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'WARN  Gist ID: Backup Gist ID is not configured yet.');
    assert.include(result.stdout, '\nNext: Run the installer to create or adopt a backup Gist.');
    assert.include(result.stdout, 'WARN  GitHub CLI: GitHub CLI is not discoverable on PATH.');
    assert.include(result.stdout, '\nNext: Install GitHub CLI and authenticate it for your backup host.');
    assert.notInclude(result.stdout, '      Next:');
    assert.notInclude(result.stdout, 'OK    Node.js runtime:');
    assert.notInclude(result.stdout, 'OK    Command shims on PATH:');
    assert.notInclude(result.stdout, 'OK    Config readability:');
    assert.notInclude(result.stdout, 'OK    Gist host:');
    assert.notInclude(result.stdout, 'INFO  GitHub CLI authentication: Skipping GitHub CLI authentication check because gh is not on PATH.');
    assert.notInclude(result.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
    assert.equal(result.stderr, '');
    assert.isFalse(fs.existsSync(commandLogPath));

    const verboseResult = runBallin(['doctor', '--verbose']);

    assert.equal(verboseResult.status, 0, verboseResult.stderr);
    assert.include(verboseResult.stdout, 'OK    Node.js runtime:');
    assert.include(verboseResult.stdout, 'WARN  Gist ID: Backup Gist ID is not configured yet.');
    assert.include(verboseResult.stdout, '      Next: Run the installer to create or adopt a backup Gist.');
    assert.include(verboseResult.stdout, 'INFO  GitHub CLI authentication: Skipping GitHub CLI authentication check because gh is not on PATH.');
    assert.include(verboseResult.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
  });

  it('fails doctor when a required health check fails', () => {
    fs.rmSync(path.join(binDir, 'up'));
    writeConfig({
      up: {},
      gu: {
        id: null,
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });

    const missingShim = runBallin(['doctor']);

    assert.equal(missingShim.status, 1);
    assert.include(missingShim.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: up.');
    assert.include(missingShim.stdout, '\nNext: Run the installer again or add the Ballin command directory to PATH.');
    assert.include(missingShim.stdout, 'WARN  Gist ID: Backup Gist ID is not configured yet.');
    assert.include(missingShim.stdout, '\nNext: Run the installer to create or adopt a backup Gist.');
    assert.notInclude(missingShim.stdout, '      Next:');
    assert.notInclude(missingShim.stdout, 'OK    Node.js runtime:');
    assert.notInclude(missingShim.stdout, 'OK    Config readability:');
    assert.notInclude(missingShim.stdout, 'INFO');
    assert.notInclude(missingShim.stdout, 'Result: Ballin-managed environment has errors.');

    fs.rmSync(configPath);
    const missingConfig = runBallin(['doctor']);

    assert.equal(missingConfig.status, 1);
    assert.include(missingConfig.stdout, 'ERROR Config readability: Unable to read');
    assert.include(missingConfig.stdout, 'Next: Recreate ballin.config.json from config/.defaultConfig.json.');
  });

  it('rejects invalid doctor usage', () => {
    const result = runBallin(['doctor', 'extra']);
    const verboseWithExtra = runBallin(['doctor', '--verbose', 'extra']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: ballin doctor [--verbose]\n');
    assert.equal(verboseWithExtra.status, 2);
    assert.equal(verboseWithExtra.stdout, '');
    assert.equal(verboseWithExtra.stderr, 'Usage: ballin doctor [--verbose]\n');
  });
});
