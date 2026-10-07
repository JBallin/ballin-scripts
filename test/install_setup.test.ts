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
  configure,
  configureBackup,
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
    ['.defaultConfig.json', 'commands.ts', 'index.ts', 'store.ts', 'updateConfig.ts'].forEach((fileName) => {
      fs.copyFileSync(
        path.join(repoRoot, 'config', fileName),
        path.join(repoDir, 'config', fileName),
      );
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

  it('propagates an installed config migration failure without reporting success or changing config', () => {
    installConfigSources();
    const configFile = path.join(repoDir, 'ballin.config.json');
    const original = '{"backup":{"id":null},"custom":"preserve"}\n';
    fs.writeFileSync(configFile, original);
    fs.writeFileSync(path.join(repoDir, 'config', 'updateConfig.ts'), "process.stderr.write('fixture migration failed\\n'); process.exitCode = 1;\n");
    const result = spawnSync(process.execPath, [installSetupPath, 'configure', repoDir, docsUrl], {
      encoding: 'utf8', env: childEnvironment(),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'fixture migration failed\n');
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    assert.equal(commandLog(), '');
  });

  it('rejects repository setup while a Gist is configured before contacting GitHub or changing config', () => {
    const configFile = path.join(repoDir, 'ballin.config.json');
    const original = '{"backup":{"id":"returning-gist-id","host":"github.example.test"}}\n';
    fs.writeFileSync(configFile, original);
    const { output, result } = withEnvironment(childEnvironment({
      FAKE_COMMAND_LOG: commandLogPath, FAKE_GH_AUTH_STATUS: '0',
    }), () => captureStdout(() => configureBackup(repoDir, docsUrl, {
      configPath: configFile, repositoryName: 'independent-backup',
    })));
    assert.isFalse(result);
    assert.include(output, 'Gist');
    assert.include(output, 'retired');
    assert.include(output, 'ballin backup disconnect');
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
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
    assert.notInclude(result.stdout, `symlinked binaries into ${binDir}`);
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

  it('stops before setup work when the command directory is missing from PATH', () => {
    installConfigSources();

    const result = withEnvironment({
      HOME: path.join(testDir, 'home'),
      PATH: path.join(testDir, 'other-bin'),
    }, () => captureStdout(() => setup(repoDir, docsUrl)));

    assert.isFalse(result.result);
    assert.include(result.output, `${binDir} doesn't seem to be in your path.`);
    assert.include(result.output, `Add \`export PATH="${binDir}:$PATH"\` to your shell profile.\n`);
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
    assert.notInclude(result.output, `symlinked binaries into ${brewBinDir}`);
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
    assert.notInclude(result.output, `symlinked binaries into ${binDir}`);
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
    assert.notInclude(result.stdout, '😎 ballin!');
  });

  for (const fail of [false, true]) {
    it(`keeps refresh output focused while preserving symlink failures (${fail})`, () => {
      installConfigSources();
      fs.copyFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), path.join(repoDir, 'ballin.config.json'));
      if (fail) fs.rmSync(sourceBinDir, { recursive: true });
      const result = spawnSync(process.execPath, [
        installSetupPath, 'setup', repoDir, docsUrl, '', 'refresh',
      ], {
        encoding: 'utf8',
        env: { HOME: path.join(testDir, 'home'), PATH: binDir, BALLIN_NO_ANALYTICS: '1' },
      });

      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.notInclude(result.stdout, 'symlinked binaries into');
      assert.notInclude(result.stdout, '😎 ballin!');
      if (fail) assert.include(result.stdout, `Unable to symlink binaries into ${binDir}`);
      else assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
    });
  }

  it('owns the analytics disclosure and default-aware prompt copy', () => {
    assert.equal(
      analyticsDisclosureFor('https://example.test/analytics'),
      'Ballin can report command usage and results, backup results, and automatic backup/self-update results during ballin update.\n'
      + 'Backup contents, destination identities and configuration values are not sent.\n'
      + 'Reports include a random install ID stored locally.\n'
      + 'https://example.test/analytics',
    );
    assert.equal(analyticsPrompt, 'Share usage analytics to help improve Ballin? [y/N] ');
    assert.equal(analyticsPromptFor(true), 'Share usage analytics to help improve Ballin? [Y/n] ');
    assert.equal(analyticsPromptFor(false), 'Share usage analytics to help improve Ballin? [y/N] ');
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
    { name: 'blank', response: '', enabled: false },
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
      assert.notInclude(result.stdout, 'Usage analytics are currently');
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

  ['true', 'false'].forEach((enabled) => {
    [false, true].forEach((eof) => {
      it(`preserves the current analytics choice ${enabled} on ${eof ? 'EOF' : 'Enter'} when revisiting`, () => {
        const configPath = path.join(repoDir, 'ballin.config.json');
        fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled } }));
        const script = `const { configureAnalyticsPreference } = require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))});
process.exitCode = configureAnalyticsPreference({
  configPath: ${JSON.stringify(configPath)},
  defaultEnabled: ${enabled === 'true'},
}) ? 0 : 1;`;
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8', input: eof ? '' : '\n', env: childEnvironment(),
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.include(result.stdout, analyticsPromptFor(enabled === 'true'));
        assert.equal(readRepoConfig().analytics.enabled, enabled);
      });
    });
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
      encoding: 'utf8', input: 'y\nn\n', env: childEnvironment({ NODE_OPTIONS: `--require=${preloadPath}` }),
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
    assert.isBelow(result.stdout.indexOf(analyticsPrompt), result.stdout.indexOf(`${docsUrl}#shell-completion`));
    assert.include(result.stdout, 'Ballin backup is optional. Backups are stored in a private GitHub repository.\nGitHub and anyone authorized to access the repository can read its contents.');
    assert.include(result.stdout, `${docsUrl}#shell-completion\n\nBallin backup is optional.`);
    assert.notInclude(result.stdout, 'Enable shell completion?');
    assert.include(result.stdout, 'Backup setup skipped. Run `ballin backup setup`');
    assert.equal(result.stdout.match(/😎 ballin!/gu)?.length, 1);
    assert.notInclude(result.stdout, 'symlinked binaries');
    assert.notInclude(result.stdout, 'Automatically run `ballin backup` as part of `ballin update`?');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.equal(readRepoConfig().analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(installIdPath()));
    assert.notInclude(commandLog(), 'gh:');
    assert.equal(readRepoConfig().update.backup, 'false');
  });

  for (const enableCompletion of [false, true]) {
    it(`separates completion guidance from backup setup (completion enabled: ${enableCompletion})`, () => {
      installConfigSources();
      const preloadPath = path.join(testDir, 'interactive-completion.cjs');
      fs.writeFileSync(preloadPath, 'process.stdin.isTTY = true;\n');
      const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
        encoding: 'utf8', input: `n\nhome\n${enableCompletion ? 'y' : 'n'}\nn\n`,
        env: childEnvironment({ SHELL: '/bin/zsh', NODE_OPTIONS: `--require=${preloadPath}` }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const completionResult = enableCompletion
        ? 'Shell completion enabled. Open a new terminal or reload this startup file.'
        : `${docsUrl}#shell-completion`;
      assert.include(result.stdout, `${completionResult}\n\nBallin backup is optional.`);
      assert.equal(fs.existsSync(path.join(testDir, 'home', '.zshrc')), enableCompletion);
      assert.equal(readRepoConfig().update.backup, 'false');
      assert.notInclude(commandLog(), 'gh:');
    });
  }

  for (const backupFails of [false, true]) {
    it(`preserves the original setup result when completion fails (backup failure: ${backupFails})`, () => {
      installConfigSources();
      const home = path.join(testDir, 'home');
      fs.mkdirSync(home, { recursive: true });
      const profile = path.join(home, '.zshrc');
      fs.mkdirSync(profile); // A nonregular startup file is never replaced.
      const preloadPath = path.join(testDir, 'interactive-completion.cjs');
      fs.writeFileSync(preloadPath, 'process.stdin.isTTY = true;\n');
      const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
        encoding: 'utf8', input: backupFails ? 'n\nhome\ny\n' : 'n\nhome\nn\n',
        env: childEnvironment({ SHELL: '/bin/zsh', NODE_OPTIONS: `--require=${preloadPath}` }),
      });
      assert.equal(result.status, backupFails ? 1 : 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Shell completion setup could not finish. Ballin remains installed.');
      assert.include(result.stdout, `${docsUrl}#shell-completion\n\nBallin backup is optional.`);
      assert.notInclude(result.stdout, 'symlinked binaries');
      assert.isTrue(fs.lstatSync(profile).isDirectory());
      assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    });
  }

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
    assert.include(result.stdout, 'Check gh, service availability, and account access; the cause is unconfirmed.');
    assert.notInclude(result.stdout, 'GitHub.com authentication is required');
    assert.include(result.stdout, '\nBallin remains installed. Follow the backup recovery guidance above before retrying `ballin backup setup`.\n');
    assert.notInclude(result.stdout, 'Automatically run `ballin backup` as part of `ballin update`?');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.notExists(readRepoConfig().backup.repository);
    assert.equal(readRepoConfig().update.backup, 'false');
  });

  it('completes installation and backup linkage when optional repository protection cannot be configured', function test() {
    this.timeout(5000);
    installConfigSources();
    const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
    const remote = fixtureState(); remote.exists = false; remote.faults.rulesetCreate = 'denied';
    const remotePath = path.join(testDir, 'repository-protection.json');
    fs.writeFileSync(remotePath, JSON.stringify(remote)); installRepositoryFixture(binDir, remotePath);

    const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
      encoding: 'utf8', input: 'n\ny\ncreate\n\nn\ny\n', env: childEnvironment(),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr); assert.include(result.stdout, 'current permissions');
    assert.include(result.stdout, 'backup setup can continue normally');
    assert.include(result.stdout, 'Automatically run `ballin backup` as part of `ballin update`?');
    assert.include(result.stdout, '"backup.includeSensitive" set to: "false"\n');
    assert.isBelow(result.stdout.indexOf('"backup.includeSensitive" set to: "false"'), result.stdout.indexOf('Automatically run `ballin backup` as part of `ballin update`?'));
    assert.notInclude(result.stdout, 'before retrying `ballin backup setup`');
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.deepEqual(readRepoConfig().backup.repository, fixtureDestination); assert.equal(readRepoConfig().update.backup, 'false');
    assert.equal(readRepoConfig().backup.includeSensitive, 'false');
    const saved = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
    assert.deepEqual(Object.keys(saved.commits[saved.head].files).sort(), ['.ballin-backup.json', 'README.md']);
  });

  it('reports cancelled backup setup without treating the choice as an installation error', () => {
    installConfigSources();
    const { fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
    const remote = fixtureState(); remote.exists = false;
    const remotePath = path.join(testDir, 'cancelled-repository.json');
    fs.writeFileSync(remotePath, JSON.stringify(remote)); installRepositoryFixture(binDir, remotePath);
    const result = spawnSync(process.execPath, [installSetupPath, 'setup', repoDir, docsUrl, '', 'fresh'], {
      encoding: 'utf8', input: 'n\ny\ncreate\n\nn\nn\n', env: childEnvironment(),
    });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Backup setup cancelled;');
    assert.include(result.stdout, 'Ballin remains installed. Resume optional setup later with `ballin backup setup`.');
    assert.notInclude(result.stdout + result.stderr, 'ERROR:');
    assert.notInclude(result.stdout, 'Backup setup complete.');
    assert.isNull(readRepoConfig().backup.repository ?? null);
    assert.isFalse(JSON.parse(fs.readFileSync(remotePath, 'utf8')).exists);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
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

  it('removes the internal Gist setup entrypoint without contacting GitHub', () => {
    const result = spawnSync(process.execPath, [installSetupPath, 'gist', repoDir, docsUrl], {
      encoding: 'utf8', env: childEnvironment(),
    });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unknown install setup command: gist');
    assert.equal(commandLog(), '');
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });
});
