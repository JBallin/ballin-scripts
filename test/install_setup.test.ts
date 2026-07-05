const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyticsNotice,
  analyticsNoticeFor,
} = require('../commands/analytics.ts');
const {
  configure,
  setup,
  setupAnalytics,
  symlinkBinaries,
} = require('../commands/install_setup.ts');

const installSetupPath = path.join(__dirname, '..', 'commands', 'install_setup.ts');
const repoRoot = path.join(__dirname, '..');

describe('install setup', () => {
  let testDir: string;
  let repoDir: string;
  let sourceBinDir: string;
  let binDir: string;
  let commandLogPath: string;
  const docsUrl = 'https://example.test/docs';
  const fixedInstallId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';

  const withoutStdout = (action: () => boolean): boolean => {
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      return action();
    } finally {
      process.stdout.write = originalWrite;
    }
  };

  const captureStdout = (action: () => boolean): { output: string; result: boolean } => {
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = action();
      return { output, result };
    } finally {
      process.stdout.write = originalWrite;
    }
  };

  const installIdPath = () => path.join(repoDir, '.analytics', 'install-id');

  const readInstallId = () => fs.readFileSync(installIdPath(), 'utf8');

  const writeExecutable = (name: string, contents: string, directory = binDir) => {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const commandLog = () => (fs.existsSync(commandLogPath)
    ? fs.readFileSync(commandLogPath, 'utf8')
    : '');

  const readRepoConfig = () => JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'));

  const withEnv = (env: NodeJS.ProcessEnv, action: () => { output: string; result: boolean }) => {
    const previousValues = new Map<string, string | undefined>();
    Object.keys(env).forEach((key) => {
      previousValues.set(key, process.env[key]);
      process.env[key] = env[key];
    });
    try {
      return action();
    } finally {
      previousValues.forEach((value, key) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  };

  const withoutAnalyticsOptOutEnv = (action: () => { output: string; result: boolean }) => {
    const previousCi = process.env.CI;
    const previousNoAnalytics = process.env.BALLIN_NO_ANALYTICS;
    delete process.env.CI;
    delete process.env.BALLIN_NO_ANALYTICS;
    try {
      return action();
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
      if (previousNoAnalytics === undefined) {
        delete process.env.BALLIN_NO_ANALYTICS;
      } else {
        process.env.BALLIN_NO_ANALYTICS = previousNoAnalytics;
      }
    }
  };

  const installConfigSources = () => {
    fs.mkdirSync(path.join(repoDir, 'config'), { recursive: true });
    ['.defaultConfig.json', 'index.ts', 'updateConfig.ts'].forEach((fileName) => {
      fs.copyFileSync(
        path.join(repoRoot, 'config', fileName),
        path.join(repoDir, 'config', fileName),
      );
    });
  };

  const installFakeGhCommand = () => {
    writeExecutable('gh', `#!/bin/bash
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
      if [ "$FAKE_MARKER_WITHOUT_TRAILING_NEWLINE" = '1' ]; then
        printf '%s\\n' '### Backup of your dev environment'
        printf '%s' 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)'
        exit 0
      fi
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
      printf '%s\\n' "$FAKE_RESTORED_CONFIG"
      exit "$FAKE_GIST_CONFIG_STATUS"
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

  const runGistSetup = ({
    env = {},
    guHostExisted = 'true',
    input,
  }: {
    env?: NodeJS.ProcessEnv;
    guHostExisted?: 'true' | 'false';
    input?: string;
  } = {}) => {
    const configPath = path.join(repoDir, 'ballin.config.json');
    if (fs.existsSync(configPath)) {
      const config = readRepoConfig();
      config.backup = {
        ...config.backup,
        host: 'github.example.test',
      };
      fs.writeFileSync(configPath, JSON.stringify(config));
    }

    return spawnSync(process.execPath, [
      installSetupPath,
      'gist',
      repoDir,
      docsUrl,
      guHostExisted,
    ], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        PATH: binDir,
        FAKE_COMMAND_LOG: commandLogPath,
        FAKE_GH_AUTH_STATUS: '0',
        FAKE_GIST_CONFIG_STATUS: '0',
        FAKE_RESTORED_CONFIG: '{"update":{"cleanup":"false","selfUpdate":"true","backup":"true","softwareupdate":"false","npm":"true","nvm":"true"},"backup":{"id":null,"host":"github.example.test"}}',
        TEST_DIR: testDir,
        TEST_REPO_DIR: repoDir,
        ...env,
      },
    });
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-setup-'));
    repoDir = path.join(testDir, 'repo');
    sourceBinDir = path.join(repoDir, 'bin');
    binDir = path.join(testDir, 'home', '.local', 'bin');
    commandLogPath = path.join(testDir, 'commands.log');

    fs.mkdirSync(sourceBinDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.readdirSync(path.join(repoRoot, 'bin')).forEach((command: string) => {
      fs.copyFileSync(path.join(repoRoot, 'bin', command), path.join(sourceBinDir, command));
      fs.chmodSync(path.join(sourceBinDir, command), 0o755);
    });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the command directory and symlinks repository binaries', () => {
    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('removes owned stale legacy command symlinks while symlinking repository binaries', () => {
    const ownedLegacyConfig = path.join(binDir, 'ballin_config');
    const ownedLegacyUpdate = path.join(binDir, 'ballin_update');
    const unrelatedLegacyUninstall = path.join(binDir, 'ballin_uninstall');
    fs.symlinkSync(path.join(sourceBinDir, 'ballin_config'), ownedLegacyConfig);
    fs.symlinkSync(path.join(sourceBinDir, 'ballin_update'), ownedLegacyUpdate);
    fs.symlinkSync(path.join(testDir, 'unrelated-ballin_uninstall'), unrelatedLegacyUninstall);

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.isFalse(fs.existsSync(ownedLegacyConfig));
    assert.isFalse(fs.existsSync(ownedLegacyUpdate));
    assert.isTrue(fs.lstatSync(unrelatedLegacyUninstall).isSymbolicLink());
  });

  it('creates the default config through setup code', () => {
    installConfigSources();

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
  });

  it('does not create a local install ID while creating config', () => {
    installConfigSources();

    const { output, result } = withoutAnalyticsOptOutEnv(() => captureStdout(() => configure(repoDir, docsUrl)));

    assert.isTrue(result);
    assert.notInclude(output, analyticsNotice);
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('runs config creation through the setup CLI', () => {
    installConfigSources();

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'configure',
      repoDir,
      docsUrl,
    ], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });

  it('updates an existing config through setup code', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.include(
      fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'),
      '"update"',
    );
  });

  it('shows the analytics notice and creates a local install ID for enabled config', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));

    const { output, result } = withoutAnalyticsOptOutEnv(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, `\n${analyticsNotice}\n`);
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
  });

  it('does not repeat the analytics notice when a local install ID already exists', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));
    fs.mkdirSync(path.dirname(installIdPath()), { recursive: true });
    fs.writeFileSync(installIdPath(), `${fixedInstallId}\n`, 'utf8');

    const { output, result } = withoutAnalyticsOptOutEnv(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.notInclude(output, analyticsNotice);
    assert.equal(readInstallId(), `${fixedInstallId}\n`);
  });

  it('does not create a local install ID when analytics are disabled', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'false',
      },
    }));

    const { output, result } = withoutAnalyticsOptOutEnv(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.notInclude(output, analyticsNotice);
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('does not create a local install ID when analytics are disabled by environment', () => {
    [
      { BALLIN_NO_ANALYTICS: '1' },
      { CI: 'true' },
    ].forEach((env) => {
      fs.rmSync(installIdPath(), { force: true });
      installConfigSources();
      fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
        analytics: {
          enabled: 'true',
        },
      }));

      const { output, result } = withEnv(env, () => captureStdout(() => setupAnalytics(repoDir)));

      assert.isTrue(result);
      assert.notInclude(output, analyticsNotice);
      assert.isFalse(fs.existsSync(installIdPath()));
    });
  });

  it('replaces an invalid local install ID during eligible analytics setup', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));
    fs.mkdirSync(path.dirname(installIdPath()), { recursive: true });
    fs.writeFileSync(installIdPath(), 'not-a-uuid\n', 'utf8');

    const { output, result } = withoutAnalyticsOptOutEnv(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.include(output, analyticsNotice);
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
    assert.notEqual(readInstallId(), 'not-a-uuid\n');
  });

  it('runs the symlink step through the setup CLI', () => {
    const result = spawnSync(process.execPath, [
      installSetupPath,
      'symlink-binaries',
      repoDir,
      binDir,
    ], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('runs analytics setup through the setup CLI', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));
    const childEnv = { ...process.env };
    delete childEnv.CI;
    delete childEnv.BALLIN_NO_ANALYTICS;

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'setup-analytics',
      repoDir,
      docsUrl,
    ], {
      encoding: 'utf8',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `\n${analyticsNoticeFor(docsUrl)}\n`);
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
  });

  it('reports supported setup CLI commands', () => {
    const supportedResult = spawnSync(process.execPath, [
      installSetupPath,
      'supports-command',
      'setup',
    ], {
      encoding: 'utf8',
    });
    const unsupportedResult = spawnSync(process.execPath, [
      installSetupPath,
      'supports-command',
      'old-command',
    ], {
      encoding: 'utf8',
    });

    assert.equal(supportedResult.status, 0, supportedResult.stderr);
    assert.equal(unsupportedResult.status, 1);
  });

  it('replaces existing command symlinks', () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(testDir, 'old-ballin'), path.join(binDir, 'ballin'));

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('fails when a command target cannot be replaced', () => {
    fs.mkdirSync(path.join(binDir, 'ballin'), { recursive: true });

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isFalse(result);
    assert.isTrue(fs.statSync(path.join(binDir, 'ballin')).isDirectory());
  });

  it('reports missing GitHub CLI before Gist setup', () => {
    installConfigSources();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup();

    assert.equal(result.status, 1, result.stderr);
    assert.include(result.stdout, 'GitHub CLI is required for Gist backup setup');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:');
  });

  it('reports gh authentication failures before adoption or creation', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({ env: { FAKE_GH_AUTH_STATUS: '4' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'gh is not authenticated for github.example.test');
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('skips adoption and creation when a Gist ID is already configured', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const config = readRepoConfig();
    config.backup.id = 'existing-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));

    const result = runGistSetup();

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('persists BALLIN_BACKUP_HOST and passes it to gh auth and gist commands', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({
      env: {
        BALLIN_BACKUP_HOST: 'github.enterprise.test',
        FAKE_GH_HOST: 'github.enterprise.test',
      },
      input: 'n\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readRepoConfig().backup.host, 'github.enterprise.test');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
  });

  it('prompts for a host when config migration adds backup.host', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const config = readRepoConfig();
    config.backup.id = 'existing-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));

    const result = runGistSetup({
      env: { FAKE_GH_HOST: 'github.enterprise.test' },
      guHostExisted: 'false',
      input: 'github.enterprise.test\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readRepoConfig().backup.host, 'github.enterprise.test');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('rejects invalid backup Gist IDs until a valid marker is found', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({ input: '\ny\nwrong-gist-id\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "INVALID: Expected backup marker in gist 'wrong-gist-id'");
    assert.include(commandLog(), 'gh:gist view wrong-gist-id --raw --filename .MyConfig.md');
    assert.equal(readRepoConfig().backup.id, 'returning-gist-id');
  });

  it('restores config values from an adopted backup Gist', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({ input: '\ny\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Restored ballin.config.json from your backup gist');
    assert.include(commandLog(), 'gh:gist view returning-gist-id --raw --filename ballin_config');
    const restoredConfig = JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'));
    assert.deepEqual(restoredConfig.update, {
      cleanup: 'false',
      selfUpdate: 'true',
      backup: 'true',
      softwareupdate: 'false',
      npm: 'true',
      nvm: 'true',
    });
    assert.deepEqual(restoredConfig.backup, {
      id: 'returning-gist-id',
      host: 'github.example.test',
    });
  });

  it('accepts an adopted backup marker without a trailing newline like Bash did', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({
      env: { FAKE_MARKER_WITHOUT_TRAILING_NEWLINE: '1' },
      input: '\ny\nreturning-gist-id\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Restored ballin.config.json from your backup gist');
    assert.equal(readRepoConfig().backup.id, 'returning-gist-id');
  });

  it('rolls back local config when a restored Gist config cannot migrate', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{"backup":{"id":null,"host":"github.example.test"},"local":"keep"}\n');

    const result = runGistSetup({
      env: { FAKE_RESTORED_CONFIG: '{"backup":' },
      input: '\ny\nreturning-gist-id\n',
    });

    assert.equal(result.status, 1);
    assert.deepEqual(readRepoConfig(), {
      backup: {
        id: null,
        host: 'github.example.test',
      },
      local: 'keep',
    });
    assert.notEqual(readRepoConfig().backup.id, 'returning-gist-id');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.tmp')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.previous.tmp')));
  });

  it('keeps local defaults when an adopted Gist has no config snapshot', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({
      env: { FAKE_GIST_CONFIG_STATUS: '1' },
      input: '\ny\nreturning-gist-id\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'No ballin_config snapshot was found in that gist');
    assert.equal(readRepoConfig().backup.id, 'returning-gist-id');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.tmp')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.previous.tmp')));
  });

  it('creates a new secret Gist and deletes local Gist setup files', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    fs.mkdirSync(path.join(repoDir, '.backup-cache'));

    const result = runGistSetup({ input: '\nn\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created a secret gist titled '.MyConfig'");
    assert.include(result.stdout, 'Deleted existing .backup-cache folder');
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    assert.equal(readRepoConfig().backup.id, 'new-gist-id');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.MyConfig.md')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.backup-cache')));
  });

  it('runs full setup with existing Gist settings through typed orchestration', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      backup: { id: 'existing-gist-id', host: 'github.example.test' },
      analytics: { enabled: 'false' },
    }));

    const result = withEnv({
      HOME: path.join(testDir, 'home'),
      PATH: binDir,
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_GH_AUTH_STATUS: '0',
      TEST_DIR: testDir,
      TEST_REPO_DIR: repoDir,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isTrue(result.result);
    assert.include(result.output, `symlinked binaries into ${binDir}`);
    assert.include(result.output, '😎 ballin!');
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
  });

  it('stops before setup work when the command directory is missing from PATH', () => {
    installConfigSources();

    const result = withEnv({
      HOME: path.join(testDir, 'home'),
      PATH: path.join(testDir, 'other-bin'),
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isFalse(result.result);
    assert.include(result.output, `${binDir} doesn't seem to be in your path.`);
    assert.include(result.output, `export PATH="${binDir}:$PATH"`);
  });

  it('creates a new secret Gist through the setup CLI when no backup is configured', () => {
    installConfigSources();
    installFakeGhCommand();

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'setup',
      repoDir,
      docsUrl,
    ], {
      encoding: 'utf8',
      input: '\nn\n',
      env: {
        ...process.env,
        HOME: path.join(testDir, 'home'),
        PATH: binDir,
        BALLIN_BACKUP_HOST: 'github.example.test',
        FAKE_GH_HOST: 'github.example.test',
        FAKE_COMMAND_LOG: commandLogPath,
        FAKE_GH_AUTH_STATUS: '0',
        TEST_DIR: testDir,
        TEST_REPO_DIR: repoDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created a secret gist titled '.MyConfig'");
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    assert.equal(readRepoConfig().backup.id, 'new-gist-id');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.MyConfig.md')));
  });
});
