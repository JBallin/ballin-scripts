const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');
const {
  analyticsCommandForBallinArgs,
} = require('../commands/ballin.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type StringSpawnResult = import('child_process').SpawnSyncReturns<string>;

describe('ballin', () => {
  let tempDir: string;
  let binDir: string;
  let configPath: string;
  let commandLogPath: string;

  const assertHelpOutput = (result: StringSpawnResult) => {
    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'Back up your dotfiles and update your macOS development environment.');
    assert.include(result.stdout, 'Usage:');
    assert.include(result.stdout, 'ballin <command> [options]');
    assert.include(result.stdout, 'update');
    assert.include(result.stdout, 'backup');
    assert.include(result.stdout, 'doctor');
    assert.include(result.stdout, 'config');
    assert.include(result.stdout, 'self-update');
    assert.include(result.stdout, 'uninstall');
    assert.include(result.stdout, '--verbose');
    assert.equal(result.stderr, '');
  };

  const writeExecutable = (name: string, contents = '#!/bin/bash\nexit 0\n') => {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  };

  const commandLog = (): string[] => {
    if (!fs.existsSync(commandLogPath)) {
      return [];
    }
    return fs.readFileSync(commandLogPath, 'utf8').trimEnd().split('\n').filter(Boolean);
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const writeUpdateConfig = (overrides: Record<string, string> = {}) => {
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'false',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'false',
        backup: 'false',
        ...overrides,
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

  const runBallin = (
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): StringSpawnResult => spawnSync(process.execPath, [
    ballinPath,
    ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BALLIN_NO_ANALYTICS: '1',
      BALLIN_TEST_CONFIG_PATH: configPath,
      BALLIN_TEST_BALLIN_PATH: path.join(binDir, 'ballin'),
      FAKE_COMMAND_LOG: commandLogPath,
      PATH: binDir,
      ...env,
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
  gist:view)
    if [ "$*" != "gist view test-gist-id --files" ]; then exit 2; fi
    exit "\${FAKE_GH_GIST_STATUS:-0}"
    ;;
  *) exit 2 ;;
esac
`);
    writeConfig({
      update: {},
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

  it('shows help through conventional help spellings', () => {
    assertHelpOutput(runBallin(['--help']));
    assertHelpOutput(runBallin(['help']));
  });

  it('uses canonical subcommand names for analytics', () => {
    assert.equal(analyticsCommandForBallinArgs([]), 'ballin');
    assert.equal(analyticsCommandForBallinArgs(['--help']), 'ballin');
    assert.equal(analyticsCommandForBallinArgs(['help']), 'ballin');
    assert.equal(analyticsCommandForBallinArgs(['update']), 'ballin update');
    assert.equal(analyticsCommandForBallinArgs(['backup', 'read', 'zshrc.sh']), 'ballin backup');
    assert.equal(analyticsCommandForBallinArgs(['config', 'get', 'update.cleanup']), 'ballin config');
    assert.equal(analyticsCommandForBallinArgs(['doctor', '--verbose']), 'ballin doctor');
    assert.equal(analyticsCommandForBallinArgs(['self-update']), 'ballin self-update');
    assert.equal(analyticsCommandForBallinArgs(['uninstall']), 'ballin uninstall');
    assert.equal(analyticsCommandForBallinArgs(['upd']), 'ballin');
  });

  it('rejects unknown commands without running a workflow', () => {
    const result = runBallin(['upd']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unknown Ballin command: upd\nTry: ballin --help\n');
  });

  it('routes update through the update workflow and preserves its exit status', () => {
    writeUpdateConfig({ backup: 'true' });
    writeExecutable('ballin', `#!/bin/bash
if [ "$*" != 'backup' ]; then exit 2; fi
printf '%s\\n' 'ballin backup from ballin update'
printf '%s\\n' 'ballin-backup-called' >> "$FAKE_COMMAND_LOG"
exit 17
`);

    const result = runBallin(['update']);

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'Backing up development environment');
    assert.include(result.stdout, 'ballin backup from ballin update');
    assert.deepEqual(commandLog(), ['ballin-backup-called']);
  });

  it('routes backup through the backup command implementation', () => {
    const result = runBallin(['backup', 'help']);

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'ballin backup');
    assert.equal(result.stderr, '');
  });

  it('routes config through the existing config command implementation', () => {
    const result = runBallin(['config', 'get', 'backup.id']);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'test-gist-id\n');
    assert.equal(result.stderr, '');
  });

  it('rejects extra arguments for no-argument command aliases', () => {
    const update = runBallin(['update', 'extra']);
    const selfUpdate = runBallin(['self-update', 'extra']);
    const uninstall = runBallin(['uninstall', 'extra']);

    assert.equal(update.status, 2);
    assert.equal(update.stderr, 'Usage: ballin update\n');
    assert.equal(selfUpdate.status, 2);
    assert.equal(selfUpdate.stderr, 'Usage: ballin self-update\n');
    assert.equal(uninstall.status, 2);
    assert.equal(uninstall.stderr, 'Usage: ballin uninstall\n');
  });

  it('reports a concise healthy doctor result by default', () => {
    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Your Ballin-managed environment is healthy.\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      'auth status --hostname example.test',
      'gist view test-gist-id --files',
    ]);
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
    assert.include(
      result.stdout,
      'OK    Configured Gist readability: The configured backup Gist exists and is readable. Write permission was not checked.',
    );
    assert.include(result.stdout, 'Result: Ballin-managed environment health looks good.');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      'auth status --hostname example.test',
      'gist view test-gist-id --files',
    ]);
  });

  it('reports doctor warnings without failing the command', () => {
    writeConfig({
      update: {},
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
    });

    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'WARN  Config readability: Config is readable but missing sections: analytics.');
    assert.include(result.stdout, '\nNext: Run ballin config reset to recreate the config.');
    assert.notInclude(result.stdout, '      Next:');
    assert.notInclude(result.stdout, 'OK    Node.js runtime:');
    assert.notInclude(result.stdout, 'OK    Command shims on PATH:');
    assert.notInclude(result.stdout, 'OK    Gist host:');
    assert.notInclude(result.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
    assert.equal(result.stderr, '');

    const verboseResult = runBallin(['doctor', '--verbose']);

    assert.equal(verboseResult.status, 0, verboseResult.stderr);
    assert.include(verboseResult.stdout, 'OK    Node.js runtime:');
    assert.include(verboseResult.stdout, 'WARN  Config readability: Config is readable but missing sections: analytics.');
    assert.include(verboseResult.stdout, 'OK    Configured Gist readability:');
    assert.include(verboseResult.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
  });

  it('fails doctor for unusable backup prerequisites and unreadable Gists', () => {
    writeConfig({
      update: {},
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: {},
    });
    const missingId = runBallin(['doctor']);
    assert.equal(missingId.status, 1);
    assert.include(missingId.stdout, 'ERROR Gist ID: Backup Gist ID is not configured yet.');
    assert.notInclude(missingId.stdout, 'Configured Gist readability:');

    fs.rmSync(path.join(binDir, 'gh'));
    const missingGh = runBallin(['doctor']);
    assert.equal(missingGh.status, 1);
    assert.include(missingGh.stdout, 'ERROR GitHub CLI: GitHub CLI is not discoverable on PATH.');

    writeExecutable('gh', `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$1:$2" in
  auth:status) exit "\${FAKE_GH_AUTH_STATUS:-0}" ;;
  gist:view) exit "\${FAKE_GH_GIST_STATUS:-0}" ;;
  *) exit 2 ;;
esac
`);
    writeConfig({
      update: {},
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {},
    });

    const failedAuth = runBallin(['doctor'], { FAKE_GH_AUTH_STATUS: '4' });
    assert.equal(failedAuth.status, 1);
    assert.include(failedAuth.stdout, 'ERROR GitHub CLI authentication:');
    assert.notInclude(failedAuth.stdout, 'Configured Gist readability:');

    const unreadableGist = runBallin(['doctor'], { FAKE_GH_GIST_STATUS: '4' });
    assert.equal(unreadableGist.status, 1);
    assert.include(
      unreadableGist.stdout,
      'ERROR Configured Gist readability: The configured backup Gist could not be read.',
    );
  });

  it('fails doctor when a required health check fails', () => {
    fs.rmSync(path.join(binDir, 'ballin'));
    writeConfig({
      update: {},
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });

    const missingShim = runBallin(['doctor']);

    assert.equal(missingShim.status, 1);
    assert.include(missingShim.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: ballin.');
    assert.include(missingShim.stdout, '\nNext: Run the installer again or add the Ballin command directory to PATH.');
    assert.include(missingShim.stdout, 'ERROR Gist ID: Backup Gist ID is not configured yet.');
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
    assert.include(missingConfig.stdout, 'Next: Run ballin config reset to recreate the config.');
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
