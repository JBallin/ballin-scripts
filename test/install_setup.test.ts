const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyticsNotice,
} = require('../commands/analytics.ts');
const {
  configure,
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

  const writeExecutable = (name: string, contents: string, directory = binDir) => {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const installGistConfigCommand = () => {
    writeExecutable('ballin_config', `#!/bin/bash
printf 'ballin_config:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
gist_id_file="$TEST_DIR/.configured-gist-id"
host_file="$TEST_DIR/.configured-gu-host"
configured_host='github.example.test'
if [ -f "$host_file" ]; then
  while IFS= read -r stored_host; do
    configured_host="$stored_host"
  done < "$host_file"
fi
case "$1:$2" in
  get:gu.host) printf '%s\\n' "$configured_host" ;;
  get:gu.id)
    if [ -f "$gist_id_file" ]; then
      while IFS= read -r gist_id; do
        printf '%s\\n' "$gist_id"
      done < "$gist_id_file"
    else
      printf '%s\\n' 'null'
    fi
    ;;
  set:gu.host)
    printf '%s\\n' "$3" > "$host_file"
    printf '%s\\n' "\\"gu.host\\" set to: \\"$3\\""
    ;;
  set:gu.id)
    printf '%s\\n' "$3" > "$gist_id_file"
    printf '{"up":{"cleanup":"false","ballin":"true","gu":"true","softwareupdate":"false","npm":"true","nvm":"true"},"gu":{"id":"%s","host":"%s"}}\\n' "$3" "$configured_host" > "$TEST_REPO_DIR/ballin.config.json"
    printf '%s\\n' "\\"gu.id\\" set to: \\"$3\\""
    ;;
esac
`, sourceBinDir);
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
  } = {}) => spawnSync(process.execPath, [
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
      FAKE_RESTORED_CONFIG: '{"up":{"cleanup":"false","ballin":"true","gu":"true","softwareupdate":"false","npm":"true","nvm":"true"},"gu":{"id":null,"host":"github.example.test"}}',
      TEST_DIR: testDir,
      TEST_REPO_DIR: repoDir,
      ...env,
    },
  });

  const commandLog = () => (fs.existsSync(commandLogPath)
    ? fs.readFileSync(commandLogPath, 'utf8')
    : '');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-setup-'));
    repoDir = path.join(testDir, 'repo');
    sourceBinDir = path.join(repoDir, 'bin');
    binDir = path.join(testDir, 'home', '.local', 'bin');
    commandLogPath = path.join(testDir, 'commands.log');

    fs.mkdirSync(sourceBinDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(sourceBinDir, 'ballin'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(sourceBinDir, 'gu'), '#!/usr/bin/env node\n');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the command directory and symlinks repository binaries', () => {
    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.isTrue(fs.lstatSync(path.join(binDir, 'gu')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
    assert.equal(fs.readlinkSync(path.join(binDir, 'gu')), path.join(sourceBinDir, 'gu'));
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
      '"up"',
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
    assert.include(output, analyticsNotice);
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
    ], {
      encoding: 'utf8',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, analyticsNotice);
    assert.match(readInstallId(), /^[0-9a-f-]{36}\n$/);
  });

  it('reports supported setup CLI commands', () => {
    const supportedResult = spawnSync(process.execPath, [
      installSetupPath,
      'supports-command',
      'gist',
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
    installGistConfigCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'GitHub CLI is required for Gist backup setup');
    assert.include(result.stdout, 'gh auth login --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:');
  });

  it('reports gh authentication failures before adoption or creation', () => {
    installConfigSources();
    installGistConfigCommand();
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
    installGistConfigCommand();
    installFakeGhCommand();
    fs.writeFileSync(path.join(testDir, '.configured-gist-id'), 'existing-gist-id\n');
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup();

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'gh:auth status --hostname github.example.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('persists BALLIN_GU_HOST and passes it to gh auth and gist commands', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({
      env: {
        BALLIN_GU_HOST: 'github.enterprise.test',
        FAKE_GH_HOST: 'github.enterprise.test',
      },
      input: 'n\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'ballin_config:set gu.host github.enterprise.test\n');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
  });

  it('prompts for a host when config migration adds gu.host', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.writeFileSync(path.join(testDir, '.configured-gist-id'), 'existing-gist-id\n');
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({
      env: { FAKE_GH_HOST: 'github.enterprise.test' },
      guHostExisted: 'false',
      input: 'github.enterprise.test\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(commandLog(), 'ballin_config:set gu.host github.enterprise.test\n');
    assert.include(commandLog(), 'gh:auth status --hostname github.enterprise.test');
    assert.notInclude(commandLog(), 'gh:gist');
  });

  it('rejects invalid backup Gist IDs until a valid marker is found', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({ input: '\ny\nwrong-gist-id\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "INVALID: Expected backup marker in gist 'wrong-gist-id'");
    assert.include(commandLog(), 'gh:gist view wrong-gist-id --raw --filename .MyConfig.md');
    assert.notInclude(commandLog(), 'ballin_config:set gu.id wrong-gist-id');
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
  });

  it('restores config values from an adopted backup Gist', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );

    const result = runGistSetup({ input: '\ny\nreturning-gist-id\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Restored ballin.config.json from your backup gist');
    assert.include(commandLog(), 'gh:gist view returning-gist-id --raw --filename ballin_config');
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
  });

  it('accepts an adopted backup marker without a trailing newline like Bash did', () => {
    installConfigSources();
    installGistConfigCommand();
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
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
  });

  it('rolls back local config when a restored Gist config cannot migrate', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{"gu":{"id":null,"host":"github.example.test"},"local":"keep"}\n');

    const result = runGistSetup({
      env: { FAKE_RESTORED_CONFIG: '{"gu":' },
      input: '\ny\nreturning-gist-id\n',
    });

    assert.equal(result.status, 1);
    assert.equal(
      fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'),
      '{"gu":{"id":null,"host":"github.example.test"},"local":"keep"}\n',
    );
    assert.notInclude(commandLog(), 'ballin_config:set gu.id returning-gist-id');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.tmp')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.previous.tmp')));
  });

  it('keeps local defaults when an adopted Gist has no config snapshot', () => {
    installConfigSources();
    installGistConfigCommand();
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
    assert.include(commandLog(), 'ballin_config:set gu.id returning-gist-id\n');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.tmp')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.ballin.config.restore.previous.tmp')));
  });

  it('creates a new secret Gist and deletes local Gist setup files', () => {
    installConfigSources();
    installGistConfigCommand();
    installFakeGhCommand();
    fs.copyFileSync(
      path.join(repoDir, 'config', '.defaultConfig.json'),
      path.join(repoDir, 'ballin.config.json'),
    );
    fs.mkdirSync(path.join(repoDir, '.gu-cache'));

    const result = runGistSetup({ input: '\nn\n' });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created a secret gist titled '.MyConfig'");
    assert.include(result.stdout, 'Deleted existing .gu-cache folder');
    assert.include(commandLog(), 'gh:gist create .MyConfig.md --desc ');
    assert.include(commandLog(), 'ballin_config:set gu.id new-gist-id\n');
    assert.isFalse(fs.existsSync(path.join(repoDir, '.MyConfig.md')));
    assert.isFalse(fs.existsSync(path.join(repoDir, '.gu-cache')));
  });
});
