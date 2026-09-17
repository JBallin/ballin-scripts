const { spawnSync } = require('child_process');
const { testChildEnvironment, withEnvironment } = require('./helpers/environment.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyticsDisclosureFor,
  analyticsPrompt,
  analyticsPromptFor,
  configureAnalyticsPreference,
} = require('../commands/analytics.ts');
const {
  configHasBackupHost,
  configure,
  configureGist,
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

  const analyticsEnabledEnv = {
    CI: undefined,
    BALLIN_NO_ANALYTICS: undefined,
    BALLIN_NO_COMMAND_ANALYTICS: undefined,
  };

  const withAnalyticsEnabled = (action: () => { output: string; result: boolean }) => (
    withEnvironment(analyticsEnabledEnv, action)
  );

  const childEnvironment = (overrides: NodeJS.ProcessEnv = {}) => testChildEnvironment({
    HOME: path.join(testDir, 'home'),
    PATH: binDir,
    ...overrides,
  });

  const installConfigSources = () => {
    fs.mkdirSync(path.join(repoDir, 'config'), { recursive: true });
    ['.defaultConfig.json', 'index.ts', 'store.ts', 'updateConfig.ts'].forEach((fileName) => {
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
  api:--hostname)
    if [ "$3:$4:$#" != "$expected_host:user:4" ]; then exit 2; fi
    exit "$FAKE_GH_AUTH_STATUS"
    ;;
  auth:status)
    if [ "$3" = '--active' ] && [ "$FAKE_GH_ACTIVE_FLAG_UNSUPPORTED" = '1' ]; then exit 1; fi
    if [ "$*" = "auth status --hostname $expected_host" ] && [ "$FAKE_GH_INACTIVE_ACCOUNT_EXPIRED" = '1' ]; then exit 4; fi
    if [ "$*" != "auth status --active --hostname $expected_host" ]; then exit 2; fi
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
    if [ "$3:$4:$5" = '--files:--:returning-gist-id' ]; then
      if [ "$FAKE_GIST_FILE_LIST_SIGNAL" = '1' ]; then kill -TERM "$$"; fi
      if [ -n "$FAKE_GIST_FILE_LIST_STDERR" ]; then printf '%s\\n' "$FAKE_GIST_FILE_LIST_STDERR" >&2; fi
      if [ "\${FAKE_GIST_FILE_LIST_STATUS:-0}" != '0' ]; then exit "$FAKE_GIST_FILE_LIST_STATUS"; fi
      printf '%s\\n' '.MyConfig.md'
      if [ "$FAKE_GIST_CONFIG_ABSENT" != '1' ]; then
        printf '%s\\n' 'ballin_config'
      fi
      exit 0
    fi
    if [ "$3" = 'returning-gist-id' ] && [ "$4:$5:$6" = '--raw:--filename:ballin_config' ]; then
      if [ "$FAKE_GIST_CONFIG_SIGNAL" = '1' ]; then kill -TERM "$$"; fi
      if [ -n "$FAKE_GIST_CONFIG_STDERR" ]; then printf '%s\\n' "$FAKE_GIST_CONFIG_STDERR" >&2; fi
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
    if [ -e "$TEST_REPO_DIR/.backup-cache" ] || [ -L "$TEST_REPO_DIR/.backup-cache" ]; then
      printf '%s\n' 'backup cache still existed during Gist creation' >&2
      exit 9
    fi
    if [ "$3:$4" != '.MyConfig.md:--desc' ]; then exit 2; fi
    if [ -n "$FAKE_GIST_CREATE_STDERR" ]; then printf '%s\\n' "$FAKE_GIST_CREATE_STDERR" >&2; fi
    if [ "\${FAKE_GIST_CREATE_STATUS:-0}" != '0' ]; then exit "$FAKE_GIST_CREATE_STATUS"; fi
    if [ "$FAKE_GIST_REMOVE_CONFIG" = '1' ]; then /bin/rm -f "$TEST_REPO_DIR/ballin.config.json"; fi
    printf '%s\\n' 'https://gist.github.com/new-gist-id'
    ;;
  *) exit 2 ;;
esac
`);
  };

  const runGistSetup = ({
    confirmBackup = true,
    env = {},
    guHostExisted = 'true',
    input,
    preserveBackupConfig = false,
  }: {
    confirmBackup?: boolean;
    env?: NodeJS.ProcessEnv;
    guHostExisted?: 'true' | 'false';
    input?: string;
    preserveBackupConfig?: boolean;
  } = {}) => {
    const configPath = path.join(repoDir, 'ballin.config.json');
    if (fs.existsSync(configPath) && !preserveBackupConfig) {
      const config = readRepoConfig();
      config.backup = {
        ...config.backup,
        host: 'github.example.test',
      };
      fs.writeFileSync(configPath, JSON.stringify(config));
    }
    const configuredId = readRepoConfig().backup?.id;
    const setupInput = configuredId
      ? input
      : `${confirmBackup ? 'y' : 'n'}\n${input ?? ''}`;

    return spawnSync(process.execPath, [
      installSetupPath,
      'gist',
      repoDir,
      docsUrl,
      guHostExisted,
    ], {
      encoding: 'utf8',
      input: setupInput,
      env: childEnvironment({
        FAKE_COMMAND_LOG: commandLogPath,
        FAKE_GH_AUTH_STATUS: '0',
        FAKE_GIST_FILE_LIST_STATUS: '0',
        FAKE_GIST_CONFIG_STATUS: '0',
        FAKE_RESTORED_CONFIG: '{"update":{"cleanup":"false","selfUpdate":"true","backup":"true","softwareupdate":"false","npm":"true","nvm":"true"},"backup":{"id":null,"host":"github.example.test"}}',
        TEST_DIR: testDir,
        TEST_REPO_DIR: repoDir,
        ...env,
      }),
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

  it('creates the default config through setup code', () => {
    installConfigSources();

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
  });

  it('fails config creation cleanly when required config sources are missing', () => {
    const { output, result } = captureStdout(() => configure(repoDir, docsUrl));

    assert.isFalse(result);
    assert.equal(output, '');
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });

  it('treats malformed config structures as having no usable backup host', () => {
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), 'null\n');
    assert.isFalse(configHasBackupHost(repoDir));
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{\n');
    assert.isFalse(configHasBackupHost(repoDir));
  });

  it('rejects a missing Gist config without prompting or contacting GitHub', () => {
    const missingConfig = path.join(repoDir, 'missing-config.json');

    const result = withoutStdout(() => configureGist(repoDir, docsUrl, false, {
      configPath: missingConfig,
    }));

    assert.isFalse(result);
    assert.equal(commandLog(), '');
  });

  it('does not create a local install ID while creating config', () => {
    installConfigSources();

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => configure(repoDir, docsUrl)));

    assert.isTrue(result);
    assert.notInclude(output, analyticsDisclosureFor());
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
      env: childEnvironment(),
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

  it('updates config when the repository path contains spaces and shell metacharacters', () => {
    repoDir = path.join(testDir, 'repo with spaces $(touch shell-sentinel)');
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.isFalse(fs.existsSync(path.join(repoDir, 'config', 'shell-sentinel')));
    assert.include(
      fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'),
      '"update"',
    );
  });

  it('creates a local install ID silently for enabled config', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
  });

  it('leaves an existing local install ID unchanged without output', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'true',
      },
    }));
    fs.mkdirSync(path.dirname(installIdPath()), { recursive: true });
    fs.writeFileSync(installIdPath(), `${fixedInstallId}\n`, 'utf8');

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
    assert.equal(readInstallId(), `${fixedInstallId}\n`);
  });

  it('does not create a local install ID when analytics are disabled', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: {
        enabled: 'false',
      },
    }));

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('never blocks setup when analytics state cannot be created', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      analytics: { enabled: 'true' },
    }));
    fs.writeFileSync(path.join(repoDir, '.analytics'), 'blocks analytics directory creation\n');

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('ignores structurally invalid analytics config during setup', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({ analytics: false }));

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('never blocks setup when the analytics config file disappears', () => {
    const missingConfig = path.join(repoDir, 'missing-config.json');

    const result = withoutStdout(() => setupAnalytics(repoDir, missingConfig));

    assert.isTrue(result);
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

      const { output, result } = withEnvironment({ ...analyticsEnabledEnv, ...env }, () => (
        captureStdout(() => setupAnalytics(repoDir))
      ));

      assert.isTrue(result);
      assert.equal(output, '');
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

    const { output, result } = withAnalyticsEnabled(() => captureStdout(() => setupAnalytics(repoDir)));

    assert.isTrue(result);
    assert.equal(output, '');
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
      env: childEnvironment(),
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
    const childEnv = childEnvironment(analyticsEnabledEnv);

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
    assert.equal(result.stdout, '');
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
  });

  it('reports supported setup CLI commands', () => {
    const supportedResult = spawnSync(process.execPath, [
      installSetupPath,
      'supports-command',
      'setup',
    ], {
      encoding: 'utf8',
      env: childEnvironment(),
    });
    const unsupportedResult = spawnSync(process.execPath, [
      installSetupPath,
      'supports-command',
      'old-command',
    ], {
      encoding: 'utf8',
      env: childEnvironment(),
    });

    assert.equal(supportedResult.status, 0, supportedResult.stderr);
    assert.equal(unsupportedResult.status, 1);
  });

  it('reports missing and unknown setup CLI usage with failing statuses', () => {
    const missing = spawnSync(process.execPath, [installSetupPath], { encoding: 'utf8', env: childEnvironment() });
    const unknown = spawnSync(process.execPath, [
      installSetupPath,
      'future-command',
      repoDir,
      docsUrl,
    ], { encoding: 'utf8', env: childEnvironment() });

    assert.equal(missing.status, 1);
    assert.include(missing.stdout, 'Usage: install_setup.ts');
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout, 'Unknown install setup command: future-command\n');
  });

  it('propagates configure and symlink failures through the setup CLI', () => {
    const configureResult = spawnSync(process.execPath, [
      installSetupPath,
      'configure',
      repoDir,
      docsUrl,
    ], { encoding: 'utf8', env: childEnvironment() });
    const blockedBinDir = path.join(testDir, 'blocked-bin');
    fs.writeFileSync(blockedBinDir, 'not a directory\n');
    const symlinkResult = spawnSync(process.execPath, [
      installSetupPath,
      'symlink-binaries',
      repoDir,
      blockedBinDir,
    ], { encoding: 'utf8', env: childEnvironment() });

    assert.equal(configureResult.status, 1);
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.equal(symlinkResult.status, 1);
    assert.include(symlinkResult.stdout, `Unable to create ${blockedBinDir}`);
  });

  it('replaces existing command symlinks', () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(testDir, 'old-ballin'), path.join(binDir, 'ballin'));

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('fails safely when the binary source directory disappears', () => {
    fs.rmSync(sourceBinDir, { recursive: true });
    const { output, result } = captureStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isFalse(result);
    assert.include(output, `Unable to symlink binaries into ${binDir}`);
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
    const configured = readRepoConfig();
    configured.backup.id = 'returning-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(configured));
    const result = runGistSetup();

    assert.equal(result.status, 1, result.stderr);
    assert.include(result.stdout, 'GitHub CLI is required for Gist backup setup');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:');
  });

  it('reports invalid effective-account authentication for a configured Gist', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const configured = readRepoConfig();
    configured.backup.id = 'returning-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(configured));
    const result = runGistSetup({ env: { FAKE_GH_AUTH_STATUS: '4' } });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'gh is not authenticated for github.example.test');
    assert.include(commandLog(), 'gh:api --hostname github.example.test user');
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
    config.update.backup = 'true';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));
    const cachePath = path.join(repoDir, '.backup-cache');
    fs.mkdirSync(cachePath);
    fs.writeFileSync(path.join(cachePath, 'known-base'), 'preserve me\n');

    const result = runGistSetup();

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, 'Set up optional Gist backups now?');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    assert.notInclude(result.stdout, 'Secret Gists are unlisted');
    assert.include(commandLog(), 'gh:api --hostname github.example.test user');
    assert.notInclude(commandLog(), 'gh:gist');
    assert.equal(fs.readFileSync(path.join(cachePath, 'known-base'), 'utf8'), 'preserve me\n');
    assert.equal(readRepoConfig().update.backup, 'true');
  });

  it('uses the valid active account without auth status --active on the selected host', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const configured = readRepoConfig();
    configured.backup.id = 'returning-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(configured));
    const result = runGistSetup({
      env: {
        BALLIN_BACKUP_HOST: 'github.enterprise.test',
        FAKE_GH_HOST: 'github.enterprise.test',
        FAKE_GH_ACTIVE_FLAG_UNSUPPORTED: '1',
        FAKE_GH_INACTIVE_ACCOUNT_EXPIRED: '1',
      },
      input: 'n\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readRepoConfig().backup.host, 'github.enterprise.test');
    assert.include(commandLog(), 'gh:api --hostname github.enterprise.test user');
    assert.notInclude(commandLog(), 'gh:gist create');
  });

  it('rejects a blank backup host before authentication or remote mutation', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const configured = readRepoConfig();
    configured.backup.id = 'returning-gist-id';
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(configured));
    const result = runGistSetup({ env: { BALLIN_BACKUP_HOST: '   ' } });

    assert.equal(result.status, 1);
    assert.equal(commandLog(), '');
    assert.equal(readRepoConfig().backup.id, 'returning-gist-id');
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

    const result = withEnvironment({
      BALLIN_BACKUP_HOST: 'ambient.example.test',
      FAKE_GH_AUTH_STATUS: '4',
    }, () => runGistSetup({
      env: { FAKE_GH_HOST: 'github.enterprise.test' },
      guHostExisted: 'false',
      input: 'github.enterprise.test\n',
    }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readRepoConfig().backup.host, 'github.enterprise.test');
    assert.include(commandLog(), 'gh:api --hostname github.enterprise.test user');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('defers an environment-provided host repair until the retained Gist is validated', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const config = readRepoConfig();
    config.backup = { host: 42, id: 'returning-gist-id' };
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));

    const result = runGistSetup({
      env: {
        BALLIN_BACKUP_HOST: 'github.enterprise.test',
        FAKE_GH_HOST: 'github.enterprise.test',
      },
      preserveBackupConfig: true,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readRepoConfig().backup.host, 'github.enterprise.test');
    assert.include(commandLog(), 'gh:gist view returning-gist-id --raw --filename .MyConfig.md');
  });

  it('rejects a whitespace-only prompted replacement for an invalid host', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const config = readRepoConfig();
    config.backup = { host: 42, id: 'returning-gist-id' };
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));

    const result = runGistSetup({
      input: '   \n',
      preserveBackupConfig: true,
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Invalid config value backup.host');
    assert.equal(commandLog(), '');
  });

  it('fails safely when a legacy configured Gist has no host and none is selected', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const config = readRepoConfig();
    config.backup = { id: 'existing-gist-id' };
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(config));

    const result = runGistSetup({
      guHostExisted: 'false',
      input: '\n',
      preserveBackupConfig: true,
    });

    assert.equal(result.status, 1);
    assert.equal(commandLog(), '');
  });

  it('uses the active account during configured install and self-update setup', () => {
    installConfigSources();
    installFakeGhCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
      backup: { id: 'existing-gist-id', host: 'github.example.test' },
      analytics: { enabled: 'false' },
    }));

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: binDir,
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_GH_ACTIVE_FLAG_UNSUPPORTED: '1',
      FAKE_GH_AUTH_STATUS: '0',
      FAKE_GH_INACTIVE_ACCOUNT_EXPIRED: '1',
      TEST_DIR: testDir,
      TEST_REPO_DIR: repoDir,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isTrue(result.result);
    assert.include(result.output, `symlinked binaries into ${binDir}`);
    assert.include(result.output, '😎 ballin!');
    assert.include(commandLog(), 'gh:api --hostname github.example.test user');
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
  });

  it('stops before setup work when the command directory is missing from PATH', () => {
    installConfigSources();

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: path.join(testDir, 'other-bin'),
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isFalse(result.result);
    assert.include(result.output, `${binDir} doesn't seem to be in your path.`);
    assert.include(result.output, `export PATH="${binDir}:$PATH"`);
  });

  it('stops safely when neither Homebrew nor HOME can provide a command directory', () => {
    installConfigSources();
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    delete process.env.HOME;
    process.env.PATH = binDir;
    try {
      const { output, result } = captureStdout(() => setup(repoDir, docsUrl));
      assert.isFalse(result);
      assert.equal(output, '');
      assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('reports configuration failure from full setup before creating symlinks', () => {
    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: binDir,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isFalse(result.result);
    assert.include(result.output, 'Unable to create or update ballin.config.json');
    assert.isFalse(fs.existsSync(path.join(binDir, 'ballin')));
  });

  it('uses the active Homebrew prefix for the command directory', () => {
    installConfigSources();
    const brewPrefix = path.join(testDir, 'homebrew');
    const brewBinDir = path.join(brewPrefix, 'bin');
    fs.mkdirSync(brewBinDir, { recursive: true });
    writeExecutable('brew', `#!/bin/sh
if [ "$1" = '--prefix' ]; then printf '%s\n' "${brewPrefix}"; exit 0; fi
exit 2
`);

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: `${binDir}${path.delimiter}${brewBinDir}`,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isTrue(result.result);
    assert.include(result.output, `symlinked binaries into ${brewBinDir}`);
    assert.isTrue(fs.lstatSync(path.join(brewBinDir, 'ballin')).isSymbolicLink());
  });

  it('falls back to the user command directory when brew prefix lookup fails', () => {
    installConfigSources();
    writeExecutable('brew', '#!/bin/sh\nexit 9\n');

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: binDir,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isTrue(result.result);
    assert.include(result.output, `symlinked binaries into ${binDir}`);
  });

  it('stops full setup after a symlink failure while preserving the valid config', () => {
    installConfigSources();
    fs.rmSync(sourceBinDir, { recursive: true });

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: binDir,
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isFalse(result.result);
    assert.include(result.output, `Unable to symlink binaries into ${binDir}`);
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });

  it('reaches fresh analytics onboarding before a later symlink failure', () => {
    installConfigSources();
    fs.rmSync(sourceBinDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'n\n', env: childEnvironment(analyticsEnabledEnv),
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stdout, analyticsPrompt);
    assert.isBelow(
      result.stdout.indexOf(analyticsPrompt),
      result.stdout.indexOf(`Unable to symlink binaries into ${binDir}`),
    );
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('runs refresh setup through the CLI without prompting for optional backup', () => {
    installConfigSources();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    const result = spawnSync(process.execPath, [
      installSetupPath,
      'setup',
      repoDir,
      docsUrl,
      '',
    ], {
      encoding: 'utf8',
      env: {
        HOME: path.join(testDir, 'home'),
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.notInclude(result.stdout, 'Set up optional Gist backups now?');
    assert.notInclude(result.stdout, analyticsPrompt);
    assert.include(result.stdout, '😎 ballin!');
  });

  it('owns the analytics disclosure and default-aware prompt copy', () => {
    assert.equal(
      analyticsDisclosureFor('https://example.test/analytics'),
      'Ballin can send minimal anonymous usage analytics. Details: https://example.test/analytics',
    );
    assert.equal(analyticsPrompt, 'Enable minimal anonymous usage analytics? [Y/n] ');
    assert.equal(analyticsPromptFor(false), 'Enable minimal anonymous usage analytics? [y/N] ');
  });

  ['true', 'false'].forEach((enabled) => {
    it(`preserves local analytics.enabled=${enabled} during non-interactive refresh`, () => {
      installConfigSources();
      fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify({
        analytics: { enabled },
      }));

      const result = spawnSync(process.execPath, [
        installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'refresh',
      ], {
        encoding: 'utf8', input: 'UNCONSUMED_SENTINEL\n', env: childEnvironment(analyticsEnabledEnv),
      });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, analyticsPrompt);
      assert.equal(readRepoConfig().analytics.enabled, enabled);
      assert.equal(fs.existsSync(installIdPath()), enabled === 'true');
    });
  });

  [
    { name: 'blank', response: '', enabled: true },
    { name: 'lowercase yes', response: 'y', enabled: true },
    { name: 'uppercase yes', response: 'Y', enabled: true },
    { name: 'lowercase no', response: 'n', enabled: false },
    { name: 'uppercase no', response: 'N', enabled: false },
    { name: 'EOF', response: null, enabled: false },
  ].forEach(({ name, response, enabled }) => {
    it(`persists the fresh analytics choice and creates an ID only when enabled: ${name}`, () => {
      installConfigSources();
      const result = spawnSync(process.execPath, [
        installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
      ], {
        encoding: 'utf8',
        input: response === null ? '' : `${response}\nn\n`,
        env: childEnvironment(analyticsEnabledEnv),
      });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, analyticsDisclosureFor('https://example.test/analytics'));
      assert.include(result.stdout, analyticsPrompt);
      assert.equal(readRepoConfig().analytics.enabled, String(enabled));
      assert.equal(fs.existsSync(installIdPath()), enabled);
      assert.notInclude(commandLog(), 'gh:');
    });
  });

  it('persists a fresh yes choice while an environment opt-out suppresses ID creation', () => {
    installConfigSources();
    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ BALLIN_NO_ANALYTICS: '1' }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readRepoConfig().analytics.enabled, 'true');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('lets a later caller reuse the analytics choice with a default-no preference', () => {
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled: 'true' } }));
    const script = `const { configureAnalyticsPreference } = require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))});
process.exitCode = configureAnalyticsPreference({
  configPath: ${JSON.stringify(configPath)},
  defaultEnabled: false,
  docsUrl: 'https://example.test/analytics',
}) ? 0 : 1;`;

    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', input: '\n', env: childEnvironment(),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, analyticsPromptFor(false));
    assert.equal(readRepoConfig().analytics.enabled, 'false');
  });

  it('leaves the local choice unchanged when analytics prompt input fails', () => {
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled: 'false' } }));
    const originalRead = fs.readSync;
    fs.readSync = () => { throw new Error('simulated prompt input failure'); };
    try {
      const { output, result } = captureStdout(() => configureAnalyticsPreference({
        configPath,
        docsUrl: 'https://example.test/analytics',
      }));
      assert.isFalse(result);
      assert.include(output, analyticsDisclosureFor('https://example.test/analytics'));
    } finally {
      fs.readSync = originalRead;
    }
    assert.equal(readRepoConfig().analytics.enabled, 'false');
  });

  it('keeps fresh installation usable when the analytics preference cannot be saved', () => {
    installConfigSources();
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), configPath);
    const previousConfig = fs.readFileSync(configPath, 'utf8');
    const preloadPath = path.join(testDir, 'fail-analytics-preference.cjs');
    fs.writeFileSync(preloadPath, `const fs = require('fs');
const original = fs.writeFileSync;
fs.writeFileSync = function(file, contents, ...args) {
  if (String(file).endsWith('.analytics.tmp') && String(contents).includes('"enabled": "true"')) {
    original.call(this, file, '{"analytics":', ...args);
    throw new Error('simulated analytics preference failure');
  }
  return original.call(this, file, contents, ...args);
};\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(
      result.stdout,
      'Unable to save the analytics preference; the existing local setting is unchanged.',
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    assert.deepEqual(fs.readdirSync(repoDir).filter((name: string) => name.endsWith('.analytics.tmp')), []);
  });

  it('preserves the complete config when the analytics preference cannot be committed', () => {
    installConfigSources();
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), configPath);
    const previousConfig = fs.readFileSync(configPath, 'utf8');
    const preloadPath = path.join(testDir, 'fail-analytics-preference-commit.cjs');
    fs.writeFileSync(preloadPath, `const fs = require('fs');
const original = fs.renameSync;
fs.renameSync = function(source, destination) {
  if (String(source).endsWith('.analytics.tmp') && destination === ${JSON.stringify(configPath)}) {
    throw Object.assign(new Error('simulated analytics preference commit failure'), { code: 'EIO' });
  }
  return original.call(this, source, destination);
};\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Unable to save the analytics preference');
    assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    assert.deepEqual(fs.readdirSync(repoDir).filter((name: string) => name.endsWith('.analytics.tmp')), []);
  });

  it('preserves an unowned analytics preference staging file after exclusive creation fails', () => {
    installConfigSources();
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), configPath);
    const previousConfig = fs.readFileSync(configPath, 'utf8');
    const preloadPath = path.join(testDir, 'block-analytics-preference-stage.cjs');
    fs.writeFileSync(preloadPath, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(configPath)} + '.' + process.pid + '.analytics.tmp', 'unowned staging file\\n', { mode: 0o600 });\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    const stagingFiles = fs.readdirSync(repoDir).filter((name: string) => name.endsWith('.analytics.tmp'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Unable to save the analytics preference');
    assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    assert.isAtLeast(stagingFiles.length, 1);
    stagingFiles.forEach((name: string) => {
      assert.equal(fs.readFileSync(path.join(repoDir, name), 'utf8'), 'unowned staging file\n');
    });
  });

  it('keeps setup non-blocking when analytics preference staging cleanup fails', () => {
    installConfigSources();
    const configPath = path.join(repoDir, 'ballin.config.json');
    fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), configPath);
    const previousConfig = fs.readFileSync(configPath, 'utf8');
    const preloadPath = path.join(testDir, 'fail-analytics-preference-cleanup.cjs');
    fs.writeFileSync(preloadPath, `const fs = require('fs');
const originalRename = fs.renameSync;
fs.renameSync = function(source, destination) {
  if (String(source).endsWith('.analytics.tmp') && destination === ${JSON.stringify(configPath)}) {
    throw Object.assign(new Error('simulated analytics preference commit failure'), { code: 'EIO' });
  }
  return originalRename.call(this, source, destination);
};
const originalRemove = fs.rmSync;
fs.rmSync = function(target, ...args) {
  if (String(target).endsWith('.analytics.tmp')) {
    throw Object.assign(new Error('simulated analytics preference cleanup failure'), { code: 'EIO' });
  }
  return originalRemove.call(this, target, ...args);
};\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Unable to save the analytics preference');
    assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    const stagingFiles = fs.readdirSync(repoDir).filter((name: string) => name.endsWith('.analytics.tmp'));
    assert.isAtLeast(stagingFiles.length, 1);
    stagingFiles.forEach((name: string) => {
      assert.equal(fs.statSync(path.join(repoDir, name)).mode & 0o777, 0o600);
    });
  });

  it('keeps fresh installation usable when analytics onboarding throws unexpectedly', () => {
    installConfigSources();
    const preloadPath = path.join(testDir, 'fail-analytics-onboarding.cjs');
    fs.writeFileSync(preloadPath, `require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))}).configureAnalyticsPreference = () => {
  throw new Error('simulated analytics onboarding failure');
};\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'n\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('keeps fresh installation usable when the analytics install ID cannot be saved', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, '.analytics'), 'blocks analytics directory creation\n');

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment(analyticsEnabledEnv),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readRepoConfig().analytics.enabled, 'true');
    assert.isFalse(fs.existsSync(installIdPath()));
  });

  it('does not send an analytics request during fresh installation or the choice', () => {
    installConfigSources();
    const preloadPath = path.join(testDir, 'reject-analytics-request.cjs');
    const requestMarker = path.join(testDir, 'analytics-requested');
    fs.writeFileSync(preloadPath, `delete process.env.CI;
delete process.env.BALLIN_NO_ANALYTICS;
require('https').request = () => {
  require('fs').writeFileSync(${JSON.stringify(requestMarker)}, 'attempted');
  throw new Error('analytics request attempted');
};\n`);

    const result = spawnSync(process.execPath, [
      installSetupPath, 'setup', repoDir, docsUrl, 'https://example.test/analytics', 'fresh',
    ], {
      encoding: 'utf8', input: '\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readRepoConfig().analytics.enabled, 'true');
    assert.isTrue(fs.existsSync(installIdPath()));
    assert.isFalse(fs.existsSync(requestMarker));
  });

  it('completes a fresh maintenance-only setup without GitHub CLI', () => {
    installConfigSources();
    const childEnv = childEnvironment(analyticsEnabledEnv);

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'setup',
      repoDir,
      docsUrl,
      'https://example.test/analytics',
      'fresh',
    ], {
      encoding: 'utf8',
      input: 'n\n',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "\n🧠 Created 'ballin.config.json' file in root using default settings");
    assert.isBelow(result.stdout.indexOf(analyticsPrompt), result.stdout.indexOf('\n💪 symlinked binaries'));
    assert.include(result.stdout, 'Ballin backup is optional. Backups are stored in a private GitHub repository. GitHub and anyone authorized to access the repository can read its contents.');
    assert.include(result.stdout, 'Backup setup skipped. Run ballin backup setup');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    assert.notInclude(commandLog(), 'gh:');
    assert.equal(readRepoConfig().update.backup, 'false');
  });

  it('leaves core installation usable when requested backup setup fails', () => {
    installConfigSources();

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'setup',
      repoDir,
      docsUrl,
      '',
      'fresh',
    ], {
      encoding: 'utf8',
      input: 'n\ny\n',
      env: childEnvironment(),
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'GitHub.com authentication is required');
    assert.include(result.stdout, 'Ballin maintenance is installed. Retry with: ballin backup setup');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.isNull(readRepoConfig().backup.id);
    assert.equal(readRepoConfig().update.backup, 'false');
  });

  it('leaves core installation usable when repository protection cannot be configured', function test() {
    this.timeout(5000);
    installConfigSources();
    const { fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
    const remote = fixtureState(); remote.exists = false; remote.faults.rulesetCreate = 'denied';
    const remotePath = path.join(testDir, 'repository-protection.json');
    fs.writeFileSync(remotePath, JSON.stringify(remote)); installRepositoryFixture(binDir, remotePath);

    const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
      encoding: 'utf8', input: 'n\ny\ncreate\n\nn\ny\n', env: childEnvironment(),
    });

    assert.equal(result.status, 1); assert.include(result.stdout, 'Administration write access');
    assert.include(result.stdout, 'Ballin maintenance is installed. Retry with: ballin backup setup');
    assert.include(result.stdout, 'initialized backup remains available');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.isUndefined(readRepoConfig().backup.repository); assert.equal(readRepoConfig().update.backup, 'false');
    const saved = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
    assert.deepEqual(Object.keys(saved.commits[saved.head].files).sort(), ['.ballin-backup.json', 'README.md']);
  });

  [false, true].forEach((value) => {
    it(`restores eligible update preferences without replacing the fresh analytics choice (${value})`, function test() {
      this.timeout(5000);
      installConfigSources();
      const { fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
      const remote = fixtureState({ ballin_config: JSON.stringify({
        update: Object.fromEntries(['cleanup', 'selfUpdate', 'softwareupdate', 'npm', 'nvm'].map((key) => [key, value])),
        analytics: { enabled: 'false' },
      }) });
      const remotePath = path.join(testDir, 'repository.json');
      fs.writeFileSync(remotePath, JSON.stringify(remote));
      installRepositoryFixture(binDir, remotePath);
      const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
        encoding: 'utf8', input: `y\ny\nreconnect\n\nn\ny\n${value ? 'y' : 'n'}\n`,
        env: childEnvironment(analyticsEnabledEnv),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readRepoConfig().update.backup, String(value));
      assert.equal(readRepoConfig().analytics.enabled, 'true');
      assert.isTrue(fs.existsSync(installIdPath()));
      ['cleanup', 'selfUpdate', 'softwareupdate', 'npm', 'nvm'].forEach((key) => {
        assert.equal(readRepoConfig().update[key], String(value));
      });
    });
  });

  [false, true].forEach((hasInstallId) => {
    it(`rejects malformed analytics before fresh setup can supply enabled defaults (existing ID: ${hasInstallId})`, () => {
      installConfigSources();
      const configPath = path.join(repoDir, 'ballin.config.json');
      const original = '{"analytics":false,"custom":{"keep":"LOCAL_DUMMY_SECRET"}}\n';
      fs.writeFileSync(configPath, original);
      if (hasInstallId) {
        fs.mkdirSync(path.dirname(installIdPath()), { recursive: true });
        fs.writeFileSync(installIdPath(), fixedInstallId);
      }

      const result = spawnSync(process.execPath, [
        installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh',
      ], { encoding: 'utf8', input: 'n\n', env: childEnvironment(analyticsEnabledEnv) });

      assert.equal(result.status, 1);
      assert.include(result.stdout, 'analytics');
      assert.notInclude(result.stdout + result.stderr, 'LOCAL_DUMMY_SECRET');
      assert.equal(fs.readFileSync(configPath, 'utf8'), original);
      assert.equal(fs.existsSync(installIdPath()), hasInstallId);
      if (hasInstallId) assert.equal(readInstallId(), fixedInstallId);
      assert.isFalse(fs.existsSync(path.join(binDir, 'ballin')));
      assert.equal(commandLog(), '');
    });
  });

  it('rejects new Gist creation and adoption through the internal compatibility entrypoint', () => {
    installConfigSources();
    fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), path.join(repoDir, 'ballin.config.json'));
    installFakeGhCommand();
    const result = runGistSetup({ input: 'y\nreturning-gist-id\n' });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'New Gist setup is retired');
    assert.equal(commandLog(), '');
    assert.isNull(readRepoConfig().backup.id);
  });
  it('rejects malformed and conflicting destination associations through the compatibility entrypoint', () => {
    const { fixtureDestination } = require('./helpers/repository.ts');
    for (const value of [{ backup: { id: 42 } }, { backup: { id: 'legacy', repository: fixtureDestination } }, { backup: [] }]) {
      fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), JSON.stringify(value));
      assert.isFalse(withoutStdout(() => configureGist(repoDir, docsUrl, true)));
      assert.equal(commandLog(), '');
    }
  });
});
