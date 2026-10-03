const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAnalyticsCapture, fixtureInstallId } = require('./helpers/analytics.ts');
import type { CapturedAnalyticsEvent } from './helpers/analytics.ts';

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
const repoRoot = path.join(__dirname, '..');
const snapshotFileName = 'zshrc.sh';
// Expose only the basic commands backup needs; package managers remain unavailable.
const requiredCommands = [
  'bash',
  'cat',
  'cmp',
  'cp',
  'mkdir',
  'mktemp',
  'rm',
  'ls',
  'tail',
  'node',
];
type StringSpawnResult = import('child_process').SpawnSyncReturns<string>;
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
const { repositoryCacheDirectory } = require('../commands/backup_repository.ts');
const { previousBackupSuccessLine } = require('../commands/backup_status.ts');
import type { FixtureState } from './helpers/repository.ts';
type RunBackupOptions = {
  args?: string[];
  input?: string;
  failedPaths?: string[];
  emitUnderlyingStderr?: boolean;
  brewServicesFail?: boolean;
  brewPrefix?: string;
  brewPrefixFail?: boolean;
  completionDir?: string;
  ghAuthFail?: boolean;
  ghUploadFail?: boolean;
  commandPath?: string;
  commandCwd?: string;
  homeDirOverride?: string | null;
  umask?: '000' | '022' | '077';
  env?: NodeJS.ProcessEnv;
};

describe('ballin backup', function() {
  this.timeout(15000);
  let testHomeDir: string;
  let testBinDir: string;
  let backupCacheDir: string;
  let configPath: string;
  let remoteDir: string;
  let statePath: string;
  let scratchDir: string;
  let brewLogPath: string;
  let pythonToolLogPath: string;
  let realCatPath: string;
  let previousSuccessOutput: string;

  const state = (): FixtureState => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const saveState = (value: FixtureState): void => fs.writeFileSync(statePath, JSON.stringify(value));
  const commitLink = (): string => `View changes: https://github.com/${state().login}/${state().name}/commit/${state().head}`;
  const publishedOutput = (statuses: string): string => `${statuses}${commitLink()}\n`;

  const linkRequiredCommand = (command: string) => {
    const commandPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, command))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${command} is required to run the backup test harness`);
    fs.symlinkSync(commandPath, path.join(testBinDir, command));
  };

  const writeTestExecutable = (name: string, contents: string) => {
    fs.writeFileSync(path.join(testBinDir, name), contents, { mode: 0o755 });
  };
  const installFakeBrewCommand = () => {
    writeTestExecutable('brew', `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$HOMEBREW_NO_AUTO_UPDATE" "$HOMEBREW_NO_ENV_HINTS" "$*" >> "$FAKE_BREW_LOG"
case "$*" in
  '--prefix')
    if [ "$FAKE_BREW_PREFIX_FAIL" = 'true' ]; then exit 32; fi
    printf '%s\\n' "$FAKE_BREW_PREFIX"
    ;;
  'list --formula') printf '%s\\n' 'formula-one' ;;
  'leaves') printf '%s\\n' 'leaf-one' ;;
  'list --cask') printf '%s\\n' 'cask-one' ;;
  'services list')
    printf '%s\\n' 'service-one started'
    printf '%s\\n' 'simulated services warning' >&2
    if [ "$FAKE_BREW_SERVICES_FAIL" = 'true' ]; then exit 31; fi
    ;;
  'bundle dump --file=-') printf '%s\\n' 'brew "formula-one"' ;;
  *) printf '%s\\n' 'Unexpected brew call' >&2; exit 2 ;;
esac
`);
  };

  const installNonExecutableBrewCommand = () => {
    fs.writeFileSync(path.join(testBinDir, 'brew'), 'not executable\n', { mode: 0o644 });
  };

  const installFakePythonToolCommands = () => {
    writeTestExecutable('pipx', `#!/usr/bin/env bash
printf 'pipx|%s|%s\\n' "$PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE" "$*" >> "$FAKE_PYTHON_TOOL_LOG"
if [ "$*" != 'list --json' ]; then exit 2; fi
printf '%s\\n' 'nothing has been installed with pipx' >&2
printf '%s\\n' '{"venvs":{"black":{"metadata":{"main_package":{"package":"black","package_version":"25.1.0"}}}}}'
`);
    writeTestExecutable('uv', `#!/usr/bin/env bash
printf 'uv|%s\\n' "$*" >> "$FAKE_PYTHON_TOOL_LOG"
if [ "$*" != 'tool list --show-version-specifiers --show-with --show-extras --no-progress --color never --no-config' ]; then exit 2; fi
printf '%s\\n' 'No tools installed' >&2
printf '%s\\n' 'ruff v0.14.8 (Python 3.13.7)'
`);
    writeTestExecutable('pyenv', `#!/usr/bin/env bash
printf 'pyenv|%s\\n' "$*" >> "$FAKE_PYTHON_TOOL_LOG"
if [ "$*" != 'versions --bare' ]; then exit 2; fi
printf '%s\\n' '3.12.12' '3.13.11'
`);
  };

  const installControllableCatCommand = () => {
    const catPath = fs.realpathSync(path.join(testBinDir, 'cat'));
    fs.unlinkSync(path.join(testBinDir, 'cat'));
    writeTestExecutable('cat', `#!/usr/bin/env bash
printf '%s\\n' \"$*\" >> \"$FAKE_CAT_LOG\"
IFS=':' read -r -a failed_paths <<< "$FAKE_CAT_FAILURE_PATHS"
for failed_path in "\${failed_paths[@]}"; do
  if [ -n "$failed_path" ] && [ "$1" = "$failed_path" ]; then
    if [ "$FAKE_CAT_EMIT_STDERR" = 'true' ]; then
      printf 'cat: simulated failure reading %s\n' "$1" >&2
    fi
    exit 23
  fi
done
"$REAL_CAT" "$@"
`);
    return catPath;
  };

  beforeEach(() => {
    testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-backup-'));
    testBinDir = path.join(testHomeDir, 'bin');
    backupCacheDir = repositoryCacheDirectory(
      path.join(testHomeDir, '.ballin-scripts', '.backup-cache'), fixtureDestination,
    );
    configPath = path.join(testHomeDir, 'ballin.config.json');
    remoteDir = path.join(testHomeDir, 'remote-snapshots');
    statePath = path.join(testHomeDir, 'remote.json');
    scratchDir = path.join(testHomeDir, 'tmp');
    brewLogPath = path.join(testHomeDir, 'brew.log');
    pythonToolLogPath = path.join(testHomeDir, 'python.log');
    [
      testBinDir,
      path.join(testHomeDir, '.ballin-scripts'),
      path.join(testHomeDir, 'Library', 'Application Support'),
      remoteDir,
      scratchDir,
    ].forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    fs.cpSync(path.join(repoRoot, 'config'), path.join(testHomeDir, '.ballin-scripts', 'config'), { recursive: true });
    requiredCommands.forEach(linkRequiredCommand);
    realCatPath = installControllableCatCommand();
    fs.writeFileSync(configPath, JSON.stringify({
      update: {},
      backup: { repository: fixtureDestination, includeSensitive: 'true' },
      analytics: { enabled: 'false' },
    }));
    // Keep local fixture config outside the canonical source path; preference capture has its own suite.
    saveState(fixtureState());
    installRepositoryFixture(testBinDir, statePath);
  });

  afterEach(() => fs.rmSync(testHomeDir, { recursive: true, force: true }));

  // Pass a complete child environment so real tools and credentials are not inherited.
  const runBackup = ({
    args = [],
    input,
    failedPaths = [],
    emitUnderlyingStderr = false,
    brewServicesFail = false,
    brewPrefix = path.join(testHomeDir, 'opt', 'homebrew'),
    brewPrefixFail = false,
    completionDir,
    ghAuthFail = false,
    ghUploadFail = false,
    commandPath = ballinPath,
    commandCwd = testHomeDir,
    homeDirOverride = testHomeDir,
    umask,
    env = {},
  }: RunBackupOptions = {}) => {
    const previous = previousBackupSuccessLine(path.dirname(backupCacheDir), fixtureDestination);
    previousSuccessOutput = previous ? `${previous}\n` : '';
    const before = state();
    const files = before.commits[before.head].files;
    const baselineNames = ['README.md', '.ballin-backup.json'];
    // Files provide convenient seeding/assertions; the child uses the repository fixture protocol.
    for (const name of Object.keys(files)) {
      if (!baselineNames.includes(name)) delete files[name];
    }
    for (const name of fs.readdirSync(remoteDir)) {
      files[name] = fs.readFileSync(path.join(remoteDir, name)).toString('base64');
    }
    before.faults.auth = ghAuthFail;
    before.faults.publish = ghUploadFail ? 'reject' : undefined;
    saveState(before);

    const result = spawnSync(
      umask === undefined ? commandPath : path.join(testBinDir, 'bash'),
      umask === undefined ? ['backup', ...args] : [
        '-c', 'umask "$1"; shift; exec "$@"', 'backup-test', umask, commandPath, 'backup', ...args,
      ], {
        cwd: commandCwd,
        encoding: 'utf8',
        input,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...(homeDirOverride === null ? {} : { HOME: homeDirOverride }),
          PATH: testBinDir,
          TMPDIR: scratchDir,
          ...(completionDir === undefined ? {} : { BALLIN_BACKUP_BASH_COMPLETION_DIR: completionDir }),
          BALLIN_TEST_CONFIG_PATH: configPath,
          BALLIN_TEST_REPO_DIR: path.join(testHomeDir, '.ballin-scripts'),
          BALLIN_NO_ANALYTICS: '1',
          FAKE_BREW_LOG: brewLogPath,
          FAKE_PYTHON_TOOL_LOG: pythonToolLogPath,
          FAKE_BREW_PREFIX: brewPrefix,
          FAKE_BREW_PREFIX_FAIL: brewPrefixFail ? 'true' : 'false',
          FAKE_BREW_SERVICES_FAIL: brewServicesFail ? 'true' : 'false',
          FAKE_CAT_FAILURE_PATHS: failedPaths.join(':'),
          FAKE_CAT_EMIT_STDERR: emitUnderlyingStderr ? 'true' : 'false',
          REAL_CAT: realCatPath,
          FAKE_CAT_LOG: path.join(testHomeDir, 'collector.log'),
          ...env,
        },
      },
    );
    const after = state();
    for (const [name, content] of Object.entries(after.commits[after.head].files)) {
      if (!baselineNames.includes(name)) {
        fs.writeFileSync(path.join(remoteDir, name), Buffer.from(content as string, 'base64'));
      }
    }
    return result;
  };

  const snapshotPath = () => path.join(testHomeDir, '.zshrc');
  const cachedFilePath = (fileName: string) => path.join(backupCacheDir, fileName);
  const cachedSnapshotPath = () => cachedFilePath(snapshotFileName);
  const previousSuccessOutputLine = () => previousSuccessOutput;
  const remoteSnapshotPath = () => path.join(remoteDir, snapshotFileName);
  const writeSnapshot = (content: string) => fs.writeFileSync(snapshotPath(), content);
  const seedRemote = (content: string) => fs.writeFileSync(remoteSnapshotPath(), content);
  const seedBackupCache = (content: string, alsoSeedRemote = true) => {
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), content);
    if (alsoSeedRemote) {
      seedRemote(content);
    }
  };
  const seedRemoteFile = (fileName: string, content: string) => {
    fs.writeFileSync(path.join(remoteDir, fileName), content);
  };
  const seedCacheFile = (fileName: string, content: string, alsoSeedRemote = true) => {
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedFilePath(fileName), content);
    if (alsoSeedRemote) {
      seedRemoteFile(fileName, content);
    }
  };
  const makeCachePermissive = (entryPath = backupCacheDir) => {
    const stat = fs.lstatSync(entryPath);
    fs.chmodSync(entryPath, stat.isDirectory() ? 0o777 : 0o666);
    if (stat.isDirectory()) {
      fs.readdirSync(entryPath).forEach((name: string) => {
        makeCachePermissive(path.join(entryPath, name));
      });
    }
  };
  const assertOwnerOnlyCache = (entryPath = backupCacheDir) => {
    const stat = fs.lstatSync(entryPath);
    assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, entryPath);
    if (stat.isDirectory()) {
      fs.readdirSync(entryPath).forEach((name: string) => {
        assertOwnerOnlyCache(path.join(entryPath, name));
      });
    }
  };
  const installChmodFailureLauncher = (failurePath: string) => {
    const launcherName = 'backup-chmod-failure.cjs';
    writeTestExecutable(launcherName, `#!/usr/bin/env node
const fs = require('fs');
const originalChmod = fs.chmodSync;
fs.chmodSync = (entryPath, mode) => {
  if (entryPath === ${JSON.stringify(failurePath)}) throw new Error('simulated cache chmod failure');
  return originalChmod(entryPath, mode);
};
require(${JSON.stringify(ballinPath)});
`);
    return path.join(testBinDir, launcherName);
  };

  const installCleanupFailureLauncher = (prefixes: string[]) => {
    const launcherName = 'backup-cleanup-failure.cjs';
    writeTestExecutable(launcherName, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const originalRemove = fs.rmSync;
fs.rmSync = (entryPath, options) => {
  const name = path.basename(entryPath);
  if (${JSON.stringify(prefixes)}.some((prefix) => name.startsWith(prefix))) {
    fs.appendFileSync(${JSON.stringify(path.join(testHomeDir, 'cleanup-attempts.log'))}, entryPath + '\\n');
    throw new Error('simulated temporary cleanup failure');
  }
  return originalRemove(entryPath, options);
};
require(${JSON.stringify(ballinPath)});
`);
    return path.join(testBinDir, launcherName);
  };
  const assertBackupSucceeded = (result: StringSpawnResult) => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  };
  const readLogLines = (logPath: string) => (
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
  );

  const publications = () => state().requests.filter((request) => request.payload?.query?.includes('BallinPublish'));
  const uploadedFiles = (): string[] => publications().flatMap((request) => {
    const input = request.payload?.variables?.input as { fileChanges: { additions: { path: string }[] } };
    return input.fileChanges.additions.map((file) => file.path);
  });
  const publicationCalls = () => publications();
  const brewCalls = () => readLogLines(brewLogPath);
  const pythonToolCalls = () => readLogLines(pythonToolLogPath);
  const writeBashCompletions = (brewPrefix: string, names: string[]) => {
    const completionDirectory = path.join(brewPrefix, 'etc', 'bash_completion.d');
    fs.mkdirSync(completionDirectory, { recursive: true });
    names.forEach((name) => fs.writeFileSync(path.join(completionDirectory, name), ''));
  };

  const writeAppSupportFile = (segments: string[], content: string) => {
    const filePath = path.join(testHomeDir, 'Library', 'Application Support', ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
  for (const spelling of ['help', '--help']) {
    it(`prints the top-level ${spelling} overview without backup requests`, () => {
      const result = spawnSync(process.execPath, [ballinPath, spelling], {
        encoding: 'utf8',
        env: {
          HOME: testHomeDir,
          PATH: testBinDir,
          BALLIN_TEST_CONFIG_PATH: configPath,
          BALLIN_NO_ANALYTICS: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'back up Ballin-managed environment state');
      assert.include(result.stdout, 'Run `ballin <command> --help` for command-specific help.');
      assert.equal(result.stderr, '');
      assert.deepEqual(state().requests, []);
    });
  }

  for (const destination of ['legacy', 'malformed', 'conflicting']) {
    for (const args of [[], ['read', 'zshrc.sh'], ['open'], ['setup']]) {
      it(`rejects ${destination} configuration before GitHub or collectors for ${args[0] ?? 'backup'}`, () => {
        writeSnapshot('fixture local source\n');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.backup.id = destination === 'malformed' ? {} : 'fixture-historical-id';
        if (destination === 'legacy') delete config.backup.repository;
        const original = JSON.stringify(config);
        fs.writeFileSync(configPath, original);

        const result = runBackup({ args });

        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stdout + result.stderr, 'ballin backup disconnect');
        assert.include(result.stdout + result.stderr, 'ballin backup setup');
        assert.deepEqual(state().requests, []);
        assert.deepEqual(readLogLines(path.join(testHomeDir, 'collector.log')), []);
        assert.deepEqual(fs.readdirSync(scratchDir), []);
        if (args[0] === 'setup') {
          const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          assert.deepEqual(after.backup.id, config.backup.id);
          assert.deepEqual(after.backup.repository, config.backup.repository);
        } else {
          assert.equal(fs.readFileSync(configPath, 'utf8'), original);
        }
      });
    }
  }

  for (const id of [undefined, null, 'null']) {
    it(`permits repository backups when the legacy ID is ${String(id)}`, () => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (id !== undefined) config.backup.id = id;
      fs.writeFileSync(configPath, JSON.stringify(config));
      writeSnapshot('fixture local source\n');

      assertBackupSucceeded(runBackup());
      assert.deepEqual(uploadedFiles(), [snapshotFileName]);
      assert.isAbove(readLogLines(path.join(testHomeDir, 'collector.log')).length, 0);
    });
  }

  it('remains executable through the installed symlink model', () => {
    const linkPath = path.join(testBinDir, 'ballin-link');
    fs.symlinkSync(ballinPath, linkPath);
    seedRemoteFile('vimrc', 'set number\n');

    const result = runBackup({ args: ['read', 'vimrc'], commandPath: linkPath });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
  });
  it('preserves snapshot bytes on a simulated TTY even when colors are forced', () => {
    const bytes = '\x1b[31moriginal snapshot\x1b[0m\n\n';
    seedRemoteFile('vimrc', bytes);
    const preload = path.join(testHomeDir, 'tty.cjs');
    fs.writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });');
    const result = runBackup({ args: ['read', 'vimrc'], env: {
      NODE_OPTIONS: `--require ${preload}`, TERM: 'xterm', FORCE_COLOR: '1',
    } });
    assertBackupSucceeded(result);
    assert.equal(result.stdout, bytes);
  });

  it('streams large repository files when reading a named file', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    seedRemoteFile('vimrc', largeSnapshot);

    const result = runBackup({ args: ['read', 'vimrc'] });

    assertBackupSucceeded(result);
    assert.equal(result.stdout.length, largeSnapshot.length);
    assert.equal(result.stdout.slice(0, 1), 'r');
    assert.equal(result.stdout.slice(-1), '\n');
  });


  it('snapshots VS Code and Insiders settings, keybindings, and extensions', () => {
    writeAppSupportFile(['Code', 'User', 'settings.json'], '{"fontSize":14}\n');
    writeAppSupportFile(['Code', 'User', 'keybindings.json'], '[{"key":"cmd+k"}]\n');
    writeAppSupportFile(['Code - Insiders', 'User', 'settings.json'], '{"fontSize":15}\n');
    writeAppSupportFile(
      ['Code - Insiders', 'User', 'keybindings.json'],
      '[{"key":"cmd+i"}]\n',
    );
    writeTestExecutable('code', `#!/usr/bin/env bash
if [ "$*" != '--list-extensions' ]; then exit 2; fi
printf '%s\\n' 'publisher.stable-extension'
`);
    writeTestExecutable('code-insiders', `#!/usr/bin/env bash
if [ "$*" != '--list-extensions' ]; then exit 2; fi
printf '%s\\n' 'publisher.insiders-extension'
`);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '✚ vs_extensions',
      '✚ vs_keybindings',
      '✚ vs_settings',
      '✚ vsI_extensions',
      '✚ vsI_keybindings',
      '✚ vsI_settings',
      commitLink(),
    ]);
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'vs_settings'), 'utf8'), '{"fontSize":14}\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vs_keybindings'), 'utf8'),
      '[{"key":"cmd+k"}]\n',
    );
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vs_extensions'), 'utf8'),
      'publisher.stable-extension\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'vsI_settings'), 'utf8'), '{"fontSize":15}\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vsI_keybindings'), 'utf8'),
      '[{"key":"cmd+i"}]\n',
    );
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vsI_extensions'), 'utf8'),
      'publisher.insiders-extension\n',
    );
    assert.deepEqual(uploadedFiles(), [
      'vs_settings',
      'vs_keybindings',
      'vs_extensions',
      'vsI_settings',
      'vsI_keybindings',
      'vsI_extensions',
    ]);
  });

  it('snapshots npm globals and Mac App Store apps when commands are available', () => {
    writeTestExecutable('npm', `#!/usr/bin/env bash
if [ "$*" != 'list -g --depth=0' ]; then exit 2; fi
printf '%s\\n' '/fake/npm' '+-- eslint@1.0.0'
`);
    writeTestExecutable('mas', `#!/usr/bin/env bash
if [ "$*" != 'list' ]; then exit 2; fi
printf '%s\\n' '123456 Example App'
`);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '✚ mas',
      '✚ npm_global',
      commitLink(),
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'npm_global'), 'utf8'),
      '/fake/npm\n+-- eslint@1.0.0\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'mas'), 'utf8'), '123456 Example App\n');
    assert.deepEqual(uploadedFiles(), ['npm_global', 'mas']);
  });

  it('skips Python tooling snapshots when commands are unavailable', () => {
    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine());
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'pipx')));
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'uv_tools')));
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'pyenv_versions')));
    assert.deepEqual(pythonToolCalls(), []);
  });

  it('snapshots Python tooling inventories when commands are available', () => {
    installFakePythonToolCommands();

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '✚ pipx',
      '✚ pyenv_versions',
      '✚ uv_tools',
      commitLink(),
    ]);
    assert.deepEqual(pythonToolCalls(), [
      'pipx|1|list --json',
      'uv|tool list --show-version-specifiers --show-with --show-extras --no-progress --color never --no-config',
      'pyenv|versions --bare',
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'pipx'), 'utf8'),
      '{"venvs":{"black":{"metadata":{"main_package":{"package":"black","package_version":"25.1.0"}}}}}\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'uv_tools'), 'utf8'), 'ruff v0.14.8 (Python 3.13.7)\n');
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'pyenv_versions'), 'utf8'), '3.12.12\n3.13.11\n');
    assert.deepEqual(uploadedFiles(), ['pipx', 'uv_tools', 'pyenv_versions']);
  });

  ([
    ['Apple Silicon', path.join('opt', 'homebrew')],
    ['Intel', path.join('usr', 'local')],
    ['custom', path.join('srv', 'custombrew')],
  ] as [string, string][]).forEach(([label, relativePrefix]) => {
    it(`discovers ${label}-style bash completions from the active Homebrew prefix`, () => {
      const brewPrefix = path.join(testHomeDir, relativePrefix);
      installFakeBrewCommand();
      writeBashCompletions(brewPrefix, ['git', 'npm']);

      const result = runBackup({ brewPrefix });

      assertBackupSucceeded(result);
      assert.include(result.stdout, '✚ bash_completions\n');
      assert.equal(
        fs.readFileSync(path.join(backupCacheDir, 'bash_completions'), 'utf8'),
        'git\nnpm\n',
      );
      assert.equal(brewCalls().filter((call: string) => call.endsWith('|--prefix')).length, 1);
      assert.equal(uploadedFiles().filter((name: string) => name === 'bash_completions').length, 1);
    });
  });

  it('skips bash completions when the active Homebrew completion directory is missing', () => {
    installFakeBrewCommand();

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'bash_completions')));
  });

  it('snapshots only the active prefix when multiple Homebrew prefixes coexist', () => {
    const activePrefix = path.join(testHomeDir, 'active-homebrew');
    const inactivePrefix = path.join(testHomeDir, 'inactive-homebrew');
    installFakeBrewCommand();
    writeBashCompletions(activePrefix, ['active-tool']);
    writeBashCompletions(inactivePrefix, ['inactive-tool']);

    const result = runBackup({ brewPrefix: activePrefix });

    assertBackupSucceeded(result);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'bash_completions'), 'utf8'),
      'active-tool\n',
    );
    assert.equal(uploadedFiles().filter((name: string) => name === 'bash_completions').length, 1);
  });

  it('uses an explicit bash completion directory override when brew is unavailable', () => {
    const appleSiliconPrefix = path.join(testHomeDir, 'opt', 'homebrew');
    const completionDir = path.join(appleSiliconPrefix, 'etc', 'bash_completion.d');
    writeBashCompletions(appleSiliconPrefix, ['apple-silicon-tool']);

    const result = runBackup({ completionDir });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ bash_completions\n'));
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'bash_completions'), 'utf8'),
      'apple-silicon-tool\n',
    );
    assert.deepEqual(brewCalls(), []);
  });

  it('skips bash completions instead of guessing a prefix when brew is unavailable', () => {
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);
    writeBashCompletions(path.join(testHomeDir, 'usr', 'local'), ['intel-tool']);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'bash_completions')));
    assert.deepEqual(brewCalls(), []);
  });

  it('skips Homebrew snapshots when brew resolves but is not executable', () => {
    installNonExecutableBrewCommand();
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine());
    assert.deepEqual(brewCalls(), []);
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'bash_completions')));
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'brew_list')));
  });

  it('skips bash completions instead of guessing a prefix when brew prefix discovery fails', () => {
    installFakeBrewCommand();
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);
    writeBashCompletions(path.join(testHomeDir, 'usr', 'local'), ['intel-tool']);

    const result = runBackup({ brewPrefixFail: true });

    assertBackupSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'bash_completions')));
    assert.equal(brewCalls().filter((call: string) => call.endsWith('|--prefix')).length, 1);
  });

  it('captures Homebrew inventory with flags while suppressing successful services stderr', () => {
    installFakeBrewCommand();

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '✚ Brewfile',
      '✚ brew_cask',
      '✚ brew_leaves',
      '✚ brew_list',
      '✚ brew_services',
      commitLink(),
    ]);
    assert.deepEqual(brewCalls(), [
      '1|1|--prefix',
      '1|1|list --formula',
      '1|1|leaves',
      '1|1|list --cask',
      '1|1|services list',
      '1|1|bundle dump --file=-',
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'brew_services'), 'utf8'),
      'service-one started\n',
    );
    assert.deepEqual(uploadedFiles(), [
      'brew_list',
      'brew_leaves',
      'brew_cask',
      'brew_services',
      'Brewfile',
    ]);
  });

  it('surfaces a failed collector and commits none of the other staged inventories', () => {
    installFakeBrewCommand();

    const result = runBackup({ brewServicesFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'simulated services warning\n');
    assert.include(result.stderr, 'ballin backup: failed to snapshot brew_services\n');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.deepEqual(uploadedFiles(), []);
    assert.deepEqual(fs.readdirSync(remoteDir), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('creates and uploads the first snapshot when cache and repository are missing', () => {
    writeSnapshot('alias hello="world"\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ zshrc\n'));
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'alias hello="world"\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'alias hello="world"\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  (['000', '022', '077'] as const).forEach((umask) => {
    it(`creates an owner-only cache from a restricted source with umask ${umask}`, () => {
      writeSnapshot('private snapshot\n');
      fs.chmodSync(snapshotPath(), 0o600);

      const result = runBackup({ umask });

      assertBackupSucceeded(result);
      assertOwnerOnlyCache();
      assert.equal(fs.statSync(snapshotPath()).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(snapshotPath(), 'utf8'), 'private snapshot\n');
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'private snapshot\n');
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'private snapshot\n');
      assert.deepEqual(fs.readdirSync(backupCacheDir), ['.last-success', snapshotFileName]);
      assert.lengthOf(publicationCalls(), 1);
    });
  });

  for (const failure of ['directory', 'existing file']) {
    it(`stops before authentication and collection when securing the ${failure} fails`, () => {
      writeSnapshot('new snapshot\n');
      fs.chmodSync(snapshotPath(), 0o600);
      seedBackupCache('old snapshot\n');
      makeCachePermissive();
      const failurePath = failure === 'directory' ? backupCacheDir : cachedSnapshotPath();
      const commandPath = installChmodFailureLauncher(failurePath);
      const headBefore = state().head;

      const result = runBackup({ commandPath, failedPaths: ['.zshrc'], umask: '000' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'unable to secure backup cache permissions');
      assert.include(result.stderr, 'simulated cache chmod failure');
      assert.notInclude(result.stderr, 'failed to snapshot');
      assert.equal(fs.statSync(backupCacheDir).mode & 0o777, failure === 'directory' ? 0o777 : 0o700);
      assert.equal(fs.statSync(cachedSnapshotPath()).mode & 0o777, 0o666);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old snapshot\n');
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'old snapshot\n');
      assert.equal(state().head, headBefore);
      assert.deepEqual(state().requests, []);
      assert.deepEqual(readLogLines(path.join(testHomeDir, 'collector.log')), []);
      assert.deepEqual(fs.readdirSync(scratchDir), []);
      assert.equal(fs.readFileSync(snapshotPath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.statSync(snapshotPath()).mode & 0o777, 0o600);

      const recoveredResult = runBackup({ umask: '000' });

      assertBackupSucceeded(recoveredResult);
      assertOwnerOnlyCache();
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.statSync(snapshotPath()).mode & 0o777, 0o600);
      assert.lengthOf(publicationCalls(), 1);
    });
  }

  for (const location of ['cache root', 'cache entry']) {
    it(`rejects a symbolic link at the ${location} without changing its target`, () => {
      const targetDir = path.join(testHomeDir, 'outside-cache');
      const targetFile = path.join(targetDir, 'private-file');
      const cacheRoot = path.join(testHomeDir, '.ballin-scripts', '.backup-cache');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(targetFile, 'external contents\n');
      fs.chmodSync(targetDir, 0o755);
      fs.chmodSync(targetFile, 0o644);
      const linkPath = location === 'cache root' ? cacheRoot : cachedSnapshotPath();
      if (location === 'cache entry') {
        fs.mkdirSync(backupCacheDir, { recursive: true });
        fs.chmodSync(backupCacheDir, 0o777);
        seedCacheFile('retained-cache', 'unchanged cache bytes\n', false);
      }
      fs.symlinkSync(location === 'cache root' ? targetDir : targetFile, linkPath);
      writeSnapshot('new snapshot\n');
      seedRemote('old snapshot\n');
      const headBefore = state().head;

      const result = runBackup({ failedPaths: ['.zshrc'], umask: '000' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'unable to secure backup cache permissions');
      assert.notInclude(result.stderr, 'failed to snapshot');
      assert.equal(fs.statSync(targetDir).mode & 0o777, 0o755);
      assert.equal(fs.statSync(targetFile).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), 'external contents\n');
      assert.isTrue(fs.lstatSync(linkPath).isSymbolicLink());
      assert.equal(state().head, headBefore);
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'old snapshot\n');
      if (location === 'cache entry') {
        assert.equal(fs.readFileSync(cachedFilePath('retained-cache'), 'utf8'), 'unchanged cache bytes\n');
      }
      assert.deepEqual(state().requests, []);
      assert.deepEqual(readLogLines(path.join(testHomeDir, 'collector.log')), []);
      assert.deepEqual(fs.readdirSync(scratchDir), []);

      fs.unlinkSync(linkPath);
      seedBackupCache('old snapshot\n');
      const recoveredResult = runBackup({ umask: '000' });

      assertBackupSucceeded(recoveredResult);
      assertOwnerOnlyCache();
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.lengthOf(publicationCalls(), 1);
      assert.equal(fs.statSync(targetDir).mode & 0o777, 0o755);
      assert.equal(fs.statSync(targetFile).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), 'external contents\n');
      if (location === 'cache entry') {
        assert.equal(fs.readFileSync(cachedFilePath('retained-cache'), 'utf8'), 'unchanged cache bytes\n');
      }
    });
  }

  it('repairs every existing cache entry on an unchanged run without a publication', () => {
    writeSnapshot('shared snapshot\n');
    seedBackupCache('shared snapshot\n');
    seedCacheFile('inactive-snapshot', 'old inactive snapshot\n', false);
    const leftoverDir = cachedFilePath('.ballin-backup-cache-leftover');
    const nestedDir = path.join(leftoverDir, 'nested');
    const leftoverFile = path.join(nestedDir, 'snapshot');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(leftoverFile, 'leftover contents\n');
    makeCachePermissive();

    const result = runBackup({ umask: '000' });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assertOwnerOnlyCache();
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'shared snapshot\n');
    assert.equal(fs.readFileSync(cachedFilePath('inactive-snapshot'), 'utf8'), 'old inactive snapshot\n');
    assert.equal(fs.readFileSync(leftoverFile, 'utf8'), 'leftover contents\n');
    assert.deepEqual(publicationCalls(), []);
  });

  it('retains remote and cached snapshots whose source tool is unavailable', () => {
    seedCacheFile('npm_global', 'retained npm inventory\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine());
    assert.equal(fs.readFileSync(cachedFilePath('npm_global'), 'utf8'), 'retained npm inventory\n');
    assert.equal(fs.readFileSync(path.join(remoteDir, 'npm_global'), 'utf8'), 'retained npm inventory\n');
    assert.deepEqual(uploadedFiles(), []);
  });

  it('retains remote and cached snapshots whose source discovery fails', () => {
    seedBackupCache('retained shell config\n');
    fs.symlinkSync('.zshrc', snapshotPath());

    const result = runBackup();

    assertBackupSucceeded(result);
    // Discovery failure skips this source; normal writer success still records the local run time.
    assert.equal(result.stdout, previousSuccessOutputLine());
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'retained shell config\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'retained shell config\n');
    assert.deepEqual(uploadedFiles(), []);
  });

  it('keeps a restricted cache entry owner-only when replacing its contents', () => {
    writeSnapshot('new snapshot\n');
    seedBackupCache('old snapshot\n');
    fs.chmodSync(backupCacheDir, 0o700);
    fs.chmodSync(cachedSnapshotPath(), 0o600);
    fs.chmodSync(snapshotPath(), 0o644);

    const result = runBackup({ umask: '000' });

    assertBackupSucceeded(result);
    assertOwnerOnlyCache();
    assert.equal(fs.statSync(snapshotPath()).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'new snapshot\n');
    assert.lengthOf(publicationCalls(), 1);
  });

  for (const mode of ['plain', 'tty', 'no-color']) {
    it(`sorts mixed-state results and emphasizes only changes in ${mode} output`, () => {
      fs.writeFileSync(path.join(testHomeDir, '.zprofile'), 'new profile\n');
      writeSnapshot('stable shell config\n');
      seedBackupCache('stable shell config\n');
      fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), '');
      seedCacheFile('gitconfig', 'old git config\n');
      fs.writeFileSync(path.join(testHomeDir, '.vimrc'), 'new vim config\n');
      seedCacheFile('vimrc', 'old vim config\n');

      const preload = path.join(testHomeDir, 'tty.cjs');
      fs.writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });');
      const result = runBackup({ env: mode === 'plain' ? {} : {
        NODE_OPTIONS: `--require ${preload}`,
        TERM: 'xterm',
        NO_COLOR: mode === 'no-color' ? '1' : '',
        FORCE_COLOR: '1',
      } });

      assertBackupSucceeded(result);
      assert.equal(
        result.stdout,
        previousSuccessOutputLine() + publishedOutput(mode === 'tty'
          ? '\x1b[1m✖︎ gitconfig\x1b[0m\n\x1b[1m✎ vimrc\x1b[0m\n\x1b[1m✚ zprofile\x1b[0m\n✔ zshrc\n'
          : '✖︎ gitconfig\n✎ vimrc\n✚ zprofile\n✔ zshrc\n'),
      );
      assert.deepEqual(uploadedFiles(), ['zprofile.sh', 'gitconfig', 'vimrc']);
    });
  }

  it('uses the final new-file marker for a first empty snapshot', () => {
    writeSnapshot('');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ zshrc\n'));
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'empty\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('hydrates a missing cache from unchanged repository content', () => {
    writeSnapshot('export EDITOR=vim\n');
    seedRemote('export EDITOR=vim\n');

    const result = runBackup({ umask: '000' });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export EDITOR=vim\n');
    assertOwnerOnlyCache();
    assert.deepEqual(uploadedFiles(), []);
  });

  it('captures a selected symlink outside HOME without changing its target content', () => {
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-selected-source-'));
    try {
      const sourcePath = path.join(sourceDirectory, 'shell-config');
      const content = 'export TOKEN=OUTSIDE_HOME_DUMMY_SECRET';
      fs.writeFileSync(sourcePath, content);
      fs.symlinkSync(sourcePath, snapshotPath());

      const result = runBackup();

      assertBackupSucceeded(result);
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), `${content}\n`);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), `${content}\n`);
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), content);
      assert.equal(fs.realpathSync(snapshotPath()), fs.realpathSync(sourcePath));
      assert.isTrue(fs.lstatSync(snapshotPath()).isSymbolicLink());
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('streams large repository files when hydrating a missing cache', () => {
    const largeSnapshot = `${'h'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedRemote(largeSnapshot);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(uploadedFiles(), []);
  });

  ([
    {
      name: 'adds local content when cache and remote are both missing',
      base: null,
      remote: null,
      local: 'local value\n',
      expectedStatus: 0,
      expectedOutput: '✚ zshrc\n',
      uploads: [snapshotFileName],
    },
    {
      name: 'hydrates a missing cache when remote and local match',
      base: null,
      remote: 'shared value\n',
      local: 'shared value\n',
      expectedStatus: 0,
      expectedOutput: '✔ zshrc\n',
      uploads: [],
    },
    {
      name: 'conflicts when cache is missing and remote differs from local',
      base: null,
      remote: 'remote value\n',
      local: 'local value\n',
      expectedStatus: 1,
      expectedOutput: '',
      uploads: [],
    },
    {
      name: 'leaves matching base, remote, and local content unchanged',
      base: 'shared value\n',
      remote: 'shared value\n',
      local: 'shared value\n',
      expectedStatus: 0,
      expectedOutput: '✔ zshrc\n',
      uploads: [],
    },
    {
      name: 'uploads a local change when base and remote match',
      base: 'base value\n',
      remote: 'base value\n',
      local: 'local value\n',
      expectedStatus: 0,
      expectedOutput: '✎ zshrc\n',
      uploads: [snapshotFileName],
    },
    {
      name: 'fast-forwards a stale cache when remote and local match',
      base: 'base value\n',
      remote: 'remote value\n',
      local: 'remote value\n',
      expectedStatus: 0,
      expectedOutput: '✔ zshrc\n',
      uploads: [],
    },
    {
      name: 'conflicts when remote changes while local still matches the cached base',
      base: 'base value\n',
      remote: 'remote value\n',
      local: 'base value\n',
      expectedStatus: 1,
      expectedOutput: '',
      uploads: [],
    },
    {
      name: 'conflicts when remote and local both differ from the base',
      base: 'base value\n',
      remote: 'remote value\n',
      local: 'local value\n',
      expectedStatus: 1,
      expectedOutput: '',
      uploads: [],
    },
    {
      name: 'conflicts when a cached remote base has been deleted',
      base: 'base value\n',
      remote: null,
      local: 'local value\n',
      expectedStatus: 1,
      expectedOutput: '',
      uploads: [],
    },
  ] as {
    name: string;
    base: string | null;
    remote: string | null;
    local: string;
    expectedStatus: number;
    expectedOutput: string;
    uploads: string[];
  }[]).forEach((testCase) => {
    it(`applies the three-way table: ${testCase.name}`, () => {
      writeSnapshot(testCase.local);
      if (testCase.base !== null) {
        seedBackupCache(testCase.base, false);
        makeCachePermissive();
      }
      if (testCase.remote !== null) {
        seedRemote(testCase.remote);
      }

      const result = runBackup({ umask: '000' });

      assert.equal(result.status, testCase.expectedStatus);
      assert.equal(result.stdout, previousSuccessOutputLine() + (testCase.uploads.length ? publishedOutput(testCase.expectedOutput) : testCase.expectedOutput));
      assert.deepEqual(uploadedFiles(), testCase.uploads);
      if (testCase.base !== null || testCase.expectedStatus === 0) {
        assertOwnerOnlyCache();
      }
      if (testCase.expectedStatus === 0) {
        assert.equal(result.stderr, '');
        assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), testCase.local);
        assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), testCase.local);
      } else {
        assert.include(result.stderr, `ballin backup: conflict for ${snapshotFileName}`);
        if (testCase.base === null) {
          assert.isFalse(fs.existsSync(cachedSnapshotPath()));
        } else {
          assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), testCase.base);
        }
        if (testCase.remote === null) {
          assert.isFalse(fs.existsSync(remoteSnapshotPath()));
        } else {
          assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), testCase.remote);
        }
      }
    });
  });

  it('refuses differing remote content when no cached base exists', () => {
    writeSnapshot('new value\n');
    seedRemote('old value\n');

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.include(result.stderr, 'Ballin changed neither the repository nor the backup cache contents');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'old value\n');
    assert.deepEqual(uploadedFiles(), []);
  });

  it('reports unchanged non-empty output without uploading it', () => {
    writeSnapshot('set -o vi\n');
    seedBackupCache('set -o vi\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assert.deepEqual(uploadedFiles(), []);
  });

  it('reports and uploads changed non-empty output', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✎ zshrc\n'));
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('treats a missing remote file with a warm cache as a conflict', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n', false);

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.include(result.stderr, 'the remote file is missing but this machine has a cached base');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=red\n');
    assert.isFalse(fs.existsSync(remoteSnapshotPath()));
    assert.deepEqual(uploadedFiles(), []);
  });

  it('streams large snapshot output without the default spawn buffer limit', () => {
    const largeSnapshot = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ zshrc\n'));
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.equal(fs.statSync(remoteSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('streams large snapshot stderr without the default spawn buffer limit', () => {
    writeAppSupportFile(['Code', 'User', 'settings.json'], '{}\n');
    writeTestExecutable('code', `#!/usr/bin/env bash
printf 'publisher.large-stderr\\n'
printf '%*s\\n' 1048577 '' >&2
`);

    const result = runBackup();

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, '✚ vs_extensions\n');
    assert.equal(result.stderr.length, 1024 * 1024 + 2);
    assert.equal(result.stderr.slice(0, 1), ' ');
    assert.equal(result.stderr.slice(-1), '\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vs_extensions'), 'utf8'),
      'publisher.large-stderr\n',
    );
    assert.include(uploadedFiles(), 'vs_extensions');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports and uploads non-empty output becoming empty', () => {
    writeSnapshot('');
    seedBackupCache('old content\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✖︎ zshrc\n'));
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('reports unchanged empty output explicitly without uploading it', () => {
    writeSnapshot('');
    seedBackupCache('empty\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'empty\n');
    assert.deepEqual(uploadedFiles(), []);
  });

  it('uses the new-file marker when empty becomes non-empty', () => {
    writeSnapshot('restored\n');
    seedBackupCache('empty\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ zshrc\n'));
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('preserves multiple trailing blank lines', () => {
    writeSnapshot('line\n\n\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n\n\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'line\n\n\n');
  });

  it('normalizes output missing its final newline', () => {
    writeSnapshot('line');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'line\n');
  });

  it('uploads a normalized snapshot only once when a later run is unchanged', () => {
    writeSnapshot('stable without newline');

    const firstResult = runBackup();
    const secondResult = runBackup();

    assertBackupSucceeded(firstResult);
    assertBackupSucceeded(secondResult);
    assert.equal(secondResult.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('preserves failed snapshot state, adds context, and continues later snapshots', () => {
    const gitconfigPath = path.join(testHomeDir, '.gitconfig');
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(gitconfigPath, 'new git value\n');
    seedBackupCache('old zsh value\n');
    seedRemote('old zsh value\n');
    makeCachePermissive();

    const result = runBackup({
      failedPaths: ['.zshrc'],
      emitUnderlyingStderr: true,
      umask: '000',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'cat: simulated failure reading .zshrc\n'
        + 'ballin backup: failed to snapshot zshrc.sh\n',
    );
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh value\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'old zsh value\n');
    assertOwnerOnlyCache();
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'gitconfig')));
    assert.isFalse(fs.existsSync(path.join(remoteDir, 'gitconfig')));
    assert.deepEqual(uploadedFiles(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports a silent command failure without leaving failed repository hydration behind', () => {
    writeSnapshot('not captured\n');

    const result = runBackup({ failedPaths: ['.zshrc'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: failed to snapshot zshrc.sh\n');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.isFalse(fs.existsSync(remoteSnapshotPath()));
    assert.deepEqual(uploadedFiles(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('recovers cleanly on the next successful invocation', () => {
    writeSnapshot('recovered\n');
    seedBackupCache('before failure\n');
    seedRemote('before failure\n');

    const failedResult = runBackup({ failedPaths: ['.zshrc'] });
    const recoveredResult = runBackup();

    assert.equal(failedResult.status, 1);
    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, previousSuccessOutputLine() + publishedOutput('✎ zshrc\n'));
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'recovered\n');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'recovered\n');
    assert.deepEqual(uploadedFiles(), [snapshotFileName]);
  });

  it('attempts later collectors after a failure while making no remote or cache mutation', () => {
    const gitconfigPath = path.join(testHomeDir, '.gitconfig');
    writeSnapshot('zsh value\n');
    fs.writeFileSync(gitconfigPath, 'git value\n');

    const result = runBackup({ failedPaths: ['.zshrc', '.gitconfig'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'ballin backup: failed to snapshot zshrc.sh\n'
        + 'ballin backup: failed to snapshot gitconfig\n',
    );
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.deepEqual(uploadedFiles(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('recovers from a partial multi-file cache promotion without another commit', () => {
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git value\n');
    fs.mkdirSync(cachedFilePath('gitconfig'), { recursive: true });
    makeCachePermissive();

    const failedPromotion = runBackup({ umask: '000' });

    assert.equal(failedPromotion.status, 1);
    assert.equal(failedPromotion.stdout, '');
    assert.include(failedPromotion.stderr, 'failed to promote cache for gitconfig');
    assert.include(failedPromotion.stderr, 'publication confirmed');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(path.join(remoteDir, 'gitconfig'), 'utf8'), 'new git value\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.isTrue(fs.statSync(cachedFilePath('gitconfig')).isDirectory());
    assertOwnerOnlyCache();
    assert.deepEqual(fs.readdirSync(backupCacheDir).sort(), ['gitconfig', snapshotFileName]);
    assert.deepEqual(fs.readdirSync(scratchDir), []);

    fs.rmSync(cachedFilePath('gitconfig'), { recursive: true });
    const recoveredResult = runBackup({ umask: '000' });

    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, previousSuccessOutputLine() + '✔ gitconfig\n✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'new git value\n');
    assertOwnerOnlyCache();
    assert.lengthOf(publicationCalls(), 1);
  });

  for (const prefix of ['ballin-backup-input-', 'ballin-backup-remote-']) {
    it(`retains confirmed publication and cache effects when ${prefix} cleanup fails`, () => {
      writeSnapshot('new snapshot\n');
      seedBackupCache('old snapshot\n');

      const result = runBackup({ commandPath: installCleanupFailureLauncher([prefix]) });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.lengthOf(publicationCalls(), 1);
      assertOwnerOnlyCache();
      const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
      assert.lengthOf(attempts, 1);
      assert.equal(new Set(attempts).size, attempts.length);
      assert.deepEqual(fs.readdirSync(scratchDir).sort(), attempts.map((entry: string) => path.basename(entry)).sort());
      const next = runBackup();
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
      assert.lengthOf(publicationCalls(), 1);
    });
  }

  it('reports both cleanup failures alongside a conflict and attempts every removal once', () => {
    writeSnapshot('local change\n');
    seedBackupCache('base\n');
    seedRemote('remote change\n');

    const result = runBackup({
      commandPath: installCleanupFailureLauncher(['ballin-backup-input-', 'ballin-backup-remote-']),
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'conflict for zshrc.sh');
    assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
    assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'remote change\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base\n');
    assert.deepEqual(publicationCalls(), []);
    const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
    assert.lengthOf(attempts, 2);
    assert.equal(new Set(attempts).size, attempts.length);
  });

  it('preserves collector failure and later captures when staged cleanup fails', () => {
    writeSnapshot('failed input\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'later capture\n');

    const result = runBackup({
      commandPath: installCleanupFailureLauncher(['ballin-backup-input-']),
      failedPaths: ['.zshrc'],
      emitUnderlyingStderr: true,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'cat: simulated failure reading .zshrc');
    assert.include(result.stderr, 'failed to snapshot zshrc.sh');
    assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
    assert.deepEqual(state().requests, []);
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
    assert.lengthOf(attempts, 2);
    assert.equal(new Set(attempts).size, attempts.length);
    assert.isTrue(attempts.some((entry: string) => fs.existsSync(path.join(entry, 'output'))
      && fs.readFileSync(path.join(entry, 'output'), 'utf8') === 'later capture\n'));
  });

  describe('behavioral analytics', () => {
    let capture: ReturnType<typeof createAnalyticsCapture>;
    const observedRun = (options: RunBackupOptions = {}) => runBackup({
      ...options,
      env: { ...capture.env, ...options.env },
    });
    const assertOutcome = (status: string, commandStatus = status): void => {
      const events: CapturedAnalyticsEvent[] = capture.readEvents();
      const behaviors = events.filter((event) => event.schemaVersion === 2);
      assert.lengthOf(behaviors, 1);
      assert.deepEqual(behaviors[0], {
        schemaVersion: 2, installId: fixtureInstallId,
        dateBucket: new Date().toISOString().slice(0, 10), event: 'backup.run', status,
      });
      const commands = events.filter((event) => event.schemaVersion === 1);
      assert.lengthOf(commands, 1);
      assert.equal(commands[0].command, 'ballin backup');
      assert.equal(commands[0].status, commandStatus);
    };
    beforeEach(() => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.analytics.enabled = 'true';
      fs.writeFileSync(configPath, JSON.stringify(config));
      capture = createAnalyticsCapture(testHomeDir);
    });

    it('emits one terminal success for publication and one for a later no-op', () => {
      writeSnapshot('stable\n');
      assertBackupSucceeded(observedRun());
      assertOutcome('success');
      capture.clear();

      const result = observedRun();
      assertBackupSucceeded(result);
      assert.equal(result.stdout, previousSuccessOutputLine() + '✔ zshrc\n');
      assert.lengthOf(publicationCalls(), 1);
      assertOutcome('success');
    });

    it('counts an eligible real backup with only expected unavailable sources as success', () => {
      assertBackupSucceeded(observedRun());
      assert.deepEqual(publicationCalls(), []);
      assertOutcome('success');
    });

    const failures: Array<{ name: string; prepare: () => RunBackupOptions; message: string }> = [
      {
        name: 'missing destination configuration', message: 'backup',
        prepare: () => {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          config.backup.repository = null; fs.writeFileSync(configPath, JSON.stringify(config));
          return {};
        },
      },
      { name: 'missing HOME', message: 'HOME is not set', prepare: () => ({ homeDirOverride: null }) },
      { name: 'authentication', message: 'auth', prepare: () => ({ ghAuthFail: true }) },
      { name: 'source collection', message: 'failed to snapshot', prepare: () => ({ failedPaths: ['.zshrc'] }) },
      {
        name: 'reconciliation', message: 'conflict',
        prepare: () => { seedBackupCache('base\n'); seedRemote('competing\n'); return {}; },
      },
      { name: 'publication', message: 'publication', prepare: () => ({ ghUploadFail: true }) },
    ];
    for (const { name, prepare, message } of failures) {
      it(`emits exactly one terminal failure for ${name}`, () => {
        writeSnapshot('new value\n');
        const result = observedRun(prepare());
        assert.isAbove(result.status ?? 0, 0, result.stdout + result.stderr);
        assert.include(result.stderr.toLowerCase(), message.toLowerCase());
        assertOutcome('failure');
      });
    }

    it('reports an unexpected collector exception safely and emits one terminal failure', () => {
      writeTestExecutable('exception.cjs', `#!/usr/bin/env node
const originalError = new Error('DUMMY_PRIVATE_COLLECTOR_ERROR');
require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup_snapshots.ts'))}).observeSnapshotSources = () => { throw originalError; };
const { runBackupCommand } = require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup.ts'))});
require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))}).runWithCommandAnalytics('ballin backup', () => runBackupCommand([]));
`);
      const result = observedRun({ commandPath: path.join(testBinDir, 'exception.cjs') });
      assert.equal(result.status, 1, result.stderr);
      assert.include(result.stderr, 'Unable to read backup state.');
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE_COLLECTOR_ERROR');
      assertOutcome('failure');
    });

    it('uses the real operation result even when its caller already has a failure status', () => {
      writeTestExecutable('earlier-failure.cjs', `#!/usr/bin/env node
const { runBackupCommand } = require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup.ts'))});
require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))}).runWithCommandAnalytics('ballin backup', () => {
  process.exitCode = 23;
  runBackupCommand([]);
});
`);
      writeSnapshot('successful backup\n');
      const result = observedRun({ commandPath: path.join(testBinDir, 'earlier-failure.cjs') });
      assert.equal(result.status, 23, result.stderr);
      assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'successful backup\n');
      assertOutcome('success', 'failure');
    });

    for (const args of [['setup'], ['read', 'zshrc.sh'], ['open'], ['list'], ['disconnect'], ['help'], ['verify'], ['invalid'], ['read'], ['open', 'extra']]) {
      it(`does not emit a real-backup event for ${args.join(' ')}`, () => {
        seedRemote('read-only fixture\n');
        observedRun({ args, input: 'n\n' });
        const events: CapturedAnalyticsEvent[] = capture.readEvents();
        assert.deepEqual(events.filter((event) => event.schemaVersion === 2), []);
        assert.lengthOf(events.filter((event) => event.schemaVersion === 1), 1);
        assert.deepEqual(publicationCalls(), []);
      });
    }

    it('keeps behavioral delivery when nested-command analytics are suppressed', () => {
      writeSnapshot('internal backup\n');
      assertBackupSucceeded(observedRun({ env: { BALLIN_NO_COMMAND_ANALYTICS: '1' } }));
      const events: CapturedAnalyticsEvent[] = capture.readEvents();
      assert.lengthOf(events, 1);
      assert.equal(events[0].event, 'backup.run');
      assert.equal(events[0].status, 'success');
    });

    for (const env of [{ BALLIN_NO_ANALYTICS: '1' }, { CI: 'true' }]) {
      it(`suppresses command and behavioral events with ${Object.keys(env)[0]}`, () => {
        writeSnapshot('still backed up\n');
        assertBackupSucceeded(observedRun({ env }));
        assert.deepEqual(capture.readEvents(), []);
        assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'still backed up\n');
      });
    }

    it('uses the single disabled local preference for both event types', () => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.analytics.enabled = 'false'; fs.writeFileSync(configPath, JSON.stringify(config));
      assertBackupSucceeded(observedRun());
      assert.deepEqual(capture.readEvents(), []);
    });

    for (const mode of ['throw', 'error', 'hang']) {
      it(`preserves backup output and effects when the sender ${mode === 'hang' ? 'times out' : `reports ${mode}`}`, function() {
        this.timeout(5000);
        writeSnapshot('sender-independent\n');
        const result = observedRun({ env: { BALLIN_TEST_ANALYTICS_MODE: mode } });
        assertBackupSucceeded(result);
        assert.equal(result.stdout, previousSuccessOutputLine() + publishedOutput('✚ zshrc\n'));
        assert.equal(fs.readFileSync(remoteSnapshotPath(), 'utf8'), 'sender-independent\n');
        assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'sender-independent\n');
        if (mode !== 'throw') assertOutcome('success');
      });
    }
  });
});
