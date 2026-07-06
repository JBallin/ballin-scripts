const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
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

type RunBackupOptions = {
  args?: string[];
  failedPaths?: string[];
  emitUnderlyingStderr?: boolean;
  brewServicesFail?: boolean;
  brewPrefix?: string;
  brewPrefixFail?: boolean;
  completionDir?: string;
  ghAuthFail?: boolean;
  ghInitialReadFail?: boolean;
  ghInitialReadSignal?: boolean;
  ghEditMissingFile?: boolean;
  ghUploadFail?: boolean;
  commandPath?: string;
};

describe('ballin backup', () => {
  let testHomeDir: string;
  let testBinDir: string;
  let backupCacheDir: string;
  let configPath: string;
  let fakeGistDir: string;
  let gistReadLogPath: string;
  let scratchDir: string;
  let gistUploadLogPath: string;
  let brewLogPath: string;
  let pythonToolLogPath: string;
  let openLogPath: string;
  let ballinLogPath: string;
  let realCatPath: string;

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

  const writeBackupConfig = (id: string | null = 'test-gist-id', host: string | null = 'example.test') => {
    fs.writeFileSync(configPath, `${JSON.stringify({
      update: {},
      backup: {
        id,
        ...(host === null ? {} : { host }),
      },
      analytics: {
        enabled: 'false',
      },
    })}\n`);
  };

  const installFakeGhCommand = () => {
    // Store the fake remote Gist as ordinary files inside the temporary test home.
    writeTestExecutable('gh', `#!/usr/bin/env bash
if [ "$GH_HOST" != 'example.test' ] && [ "$1:$2" != 'auth:status' ]; then
  printf '%s\\n' 'Unexpected GH_HOST' >&2
  exit 2
fi
if [ "$1:$2" = 'auth:status' ]; then
  if [ "$*" != 'auth status --hostname example.test' ]; then
    printf '%s\\n' 'Unexpected gh auth arguments' >&2
    exit 2
  fi
  if [ "$FAKE_GH_AUTH_FAIL" = 'true' ]; then
    printf '%s\\n' 'simulated gh auth failure' >&2
    exit 4
  fi
  exit 0
fi
if [ "$1:$2" != 'gist:view' ] && [ "$1:$2" != 'gist:edit' ]; then
  printf '%s\\n' 'Unexpected gh call' >&2
  exit 2
fi
if [ "$3" != 'test-gist-id' ]; then
  printf '%s\\n' 'Unexpected Gist ID' >&2
  exit 2
fi
if [ "$1:$2" = 'gist:view' ]; then
  if [ "$4" = '--web' ] && [ "$#" -eq 4 ]; then
    printf '%s\\n' "$*" >> "$FAKE_GH_WEB_LOG"
    exit 0
  fi
  if [ "$4" = '--files' ] && [ "$#" -eq 4 ]; then
    if [ "$FAKE_GH_INITIAL_READ_FAIL" = 'true' ]; then
      printf '%s\\n' 'simulated initial gh gist read failure' >&2
      exit 17
    fi
    if [ "$FAKE_GH_INITIAL_READ_SIGNAL" = 'true' ]; then
      kill -TERM "$$"
    fi
    exit 0
  fi
  if [ "$4" != '--raw' ]; then
    printf '%s\\n' 'Unexpected gh gist view arguments' >&2
    exit 2
  fi
  if [ "$5" != '--filename' ] || [ "$#" -ne 6 ]; then
    printf '%s\\n' 'Unexpected gh gist file read arguments' >&2
    exit 2
  fi
  printf '%s\\n' "$6" >> "$FAKE_GIST_READ_LOG"
  fake_gist_file="$FAKE_GIST_STORAGE_DIR/$6"
  if [ -f "$fake_gist_file" ]; then
    cat "$fake_gist_file"
  else
    exit 1
  fi
elif [ "$1:$2" = 'gist:edit' ]; then
  if [ "$4" = '--add' ] && [ "$#" -eq 5 ]; then
    cache_file="$5"
  elif [ "$4" = '--filename' ] && [ "$#" -eq 6 ]; then
    if [ "$FAKE_GH_EDIT_MISSING_FILE" = 'true' ]; then
      printf '%s\\n' 'gist has no file' >&2
      exit 20
    fi
    cache_file="$6"
    if [ "$5" != "\${cache_file##*/}" ]; then
      printf '%s\\n' 'Unexpected gh gist edit filename' >&2
      exit 2
    fi
  else
    printf '%s\\n' 'Unexpected gh gist edit arguments' >&2
    exit 2
  fi
  if [ "$FAKE_GH_UPLOAD_FAIL" = 'true' ]; then
    printf '%s\\n' 'simulated gh gist upload failure' >&2
    exit 19
  fi
  file_name="\${cache_file##*/}"
  cp "$cache_file" "$FAKE_GIST_STORAGE_DIR/$file_name"
  printf '%s\\n' "$file_name" >> "$FAKE_GIST_UPLOAD_LOG"
fi
`);
  };

  const installFakeOpenCommand = () => {
    writeTestExecutable('open', `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_OPEN_LOG"
`);
  };

  const writeInvalidConfig = () => {
    fs.writeFileSync(configPath, '{not json\n');
  };

  const removeConfig = () => {
    fs.rmSync(configPath);
  };

  const removeGhCommand = () => {
    fs.rmSync(path.join(testBinDir, 'gh'));
  };

  const makeGhCommandPermissionDenied = () => {
    fs.writeFileSync(path.join(testBinDir, 'gh'), 'not executable\n', { mode: 0o644 });
    fs.chmodSync(path.join(testBinDir, 'gh'), 0o644);
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
printf 'pipx|%s\\n' "$*" >> "$FAKE_PYTHON_TOOL_LOG"
if [ "$*" != 'list --json' ]; then exit 2; fi
printf '%s\\n' '{"venvs":{"black":{"metadata":{"main_package":{"package":"black","package_version":"25.1.0"}}}}}'
`);
    writeTestExecutable('uv', `#!/usr/bin/env bash
printf 'uv|%s\\n' "$*" >> "$FAKE_PYTHON_TOOL_LOG"
if [ "$*" != 'tool list --show-version-specifiers --show-with --show-extras --show-python --no-progress --color never --no-config' ]; then exit 2; fi
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
    backupCacheDir = path.join(testHomeDir, '.ballin-scripts', '.backup-cache');
    configPath = path.join(testHomeDir, 'ballin.config.json');
    fakeGistDir = path.join(testHomeDir, 'fake-gist');
    gistReadLogPath = path.join(testHomeDir, 'fake-gist-reads.log');
    scratchDir = path.join(testHomeDir, 'tmp');
    gistUploadLogPath = path.join(testHomeDir, 'fake-gist-uploads.log');
    brewLogPath = path.join(testHomeDir, 'fake-brew.log');
    pythonToolLogPath = path.join(testHomeDir, 'fake-python-tools.log');
    openLogPath = path.join(testHomeDir, 'fake-open.log');
    ballinLogPath = path.join(testHomeDir, 'fake-ballin.log');

    [
      testBinDir,
      path.join(testHomeDir, '.ballin-scripts'),
      path.join(testHomeDir, 'Library', 'Application Support'),
      fakeGistDir,
      scratchDir,
    ].forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
    requiredCommands.forEach(linkRequiredCommand);
    realCatPath = installControllableCatCommand();
    writeBackupConfig();
    installFakeGhCommand();
    installFakeOpenCommand();
  });

  afterEach(() => {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  });

  // Pass a complete child environment so real tools and credentials are not inherited.
  const runBackup = ({
    args = [],
    failedPaths = [],
    emitUnderlyingStderr = false,
    brewServicesFail = false,
    brewPrefix = path.join(testHomeDir, 'opt', 'homebrew'),
    brewPrefixFail = false,
    completionDir,
    ghAuthFail = false,
    ghInitialReadFail = false,
    ghInitialReadSignal = false,
    ghEditMissingFile = false,
    ghUploadFail = false,
    commandPath = ballinPath,
  }: RunBackupOptions = {}) => spawnSync(commandPath, ['backup', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      HOME: testHomeDir,
      PATH: testBinDir,
      TMPDIR: scratchDir,
      ...(completionDir === undefined ? {} : {
        BALLIN_BACKUP_BASH_COMPLETION_DIR: completionDir,
      }),
      BALLIN_TEST_CONFIG_PATH: configPath,
      BALLIN_NO_ANALYTICS: '1',
      FAKE_GIST_STORAGE_DIR: fakeGistDir,
      FAKE_GIST_READ_LOG: gistReadLogPath,
      FAKE_GIST_UPLOAD_LOG: gistUploadLogPath,
      FAKE_GH_WEB_LOG: openLogPath,
      FAKE_GH_AUTH_FAIL: ghAuthFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_FAIL: ghInitialReadFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_SIGNAL: ghInitialReadSignal ? 'true' : 'false',
      FAKE_GH_EDIT_MISSING_FILE: ghEditMissingFile ? 'true' : 'false',
      FAKE_GH_UPLOAD_FAIL: ghUploadFail ? 'true' : 'false',
      FAKE_BREW_LOG: brewLogPath,
      FAKE_PYTHON_TOOL_LOG: pythonToolLogPath,
      FAKE_OPEN_LOG: openLogPath,
      FAKE_BALLIN_LOG: ballinLogPath,
      FAKE_BREW_PREFIX: brewPrefix,
      FAKE_BREW_PREFIX_FAIL: brewPrefixFail ? 'true' : 'false',
      FAKE_BREW_SERVICES_FAIL: brewServicesFail ? 'true' : 'false',
      FAKE_CAT_FAILURE_PATHS: failedPaths.join(':'),
      FAKE_CAT_EMIT_STDERR: emitUnderlyingStderr ? 'true' : 'false',
      REAL_CAT: realCatPath,
    },
  });

  const snapshotPath = () => path.join(testHomeDir, '.zshrc');
  const cachedSnapshotPath = () => path.join(backupCacheDir, snapshotFileName);
  const fakeGistFilePath = () => path.join(fakeGistDir, snapshotFileName);
  const writeSnapshot = (content: string) => fs.writeFileSync(snapshotPath(), content);
  const seedBackupCache = (content: string) => {
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), content);
  };
  const seedFakeGist = (content: string) => fs.writeFileSync(fakeGistFilePath(), content);
  const seedFakeGistFile = (fileName: string, content: string) => {
    fs.writeFileSync(path.join(fakeGistDir, fileName), content);
  };
  const assertBackupSucceeded = (result: StringSpawnResult) => {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  };
  const readLogLines = (logPath: string) => (
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
  );
  const gistReads = () => readLogLines(gistReadLogPath);
  const gistUploads = () => readLogLines(gistUploadLogPath);
  const brewCalls = () => readLogLines(brewLogPath);
  const pythonToolCalls = () => readLogLines(pythonToolLogPath);
  const openCalls = () => readLogLines(openLogPath);
  const ballinCalls = () => readLogLines(ballinLogPath);

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

  it('opens the configured Gist through gh', () => {
    const result = runBackup({ args: ['open'] });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(openCalls(), ['gist view test-gist-id --web']);
  });

  it('opens the configured Gist without requiring a readable Gist', () => {
    const result = runBackup({ args: ['open'], ghInitialReadFail: true });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(openCalls(), ['gist view test-gist-id --web']);
    assert.deepEqual(gistReads(), []);
  });

  it('fails open when extra arguments are provided', () => {
    const result = runBackup({ args: ['open', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup open: expected no arguments\n');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('fails open when Gist config cannot be read', () => {
    writeInvalidConfig();

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'ballin backup: missing config value backup.id\n');
    assert.include(result.stderr, 'ballin backup: missing config value backup.host\n');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('treats a default null Gist ID as missing when opening', () => {
    writeBackupConfig(null);

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: missing config value backup.id\n');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('remains executable through the installed symlink model', () => {
    const linkPath = path.join(testBinDir, 'ballin-link');
    fs.symlinkSync(ballinPath, linkPath);
    seedFakeGistFile('vimrc', 'set number\n');

    const result = runBackup({ args: ['read', 'vimrc'], commandPath: linkPath });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
  });

  it('uses a shell-style signal exit status for open', () => {
    writeTestExecutable('gh', `#!/usr/bin/env bash
if [ "$1:$2" = 'auth:status' ]; then exit 0; fi
if [ "$*" = 'gist view test-gist-id --web' ]; then kill -TERM "$$"; fi
exit 2
`);

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 143);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('reports missing gh before opening', () => {
    removeGhCommand();

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: command not found\n');
  });

  it('reports permission-denied gh before opening', () => {
    makeGhCommandPermissionDenied();

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 126);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: Permission denied\n');
  });

  it('prints help through the ballin command', () => {
    const result = runBackup({ args: ['help'] });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'ballin backup');
  });

  it('prints help without requiring a readable Gist', () => {
    const result = runBackup({ args: ['help'], ghInitialReadFail: true });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'ballin backup');
    assert.deepEqual(gistReads(), []);
  });

  it('fails help when extra arguments are provided', () => {
    const result = runBackup({ args: ['help', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup help: expected no arguments\n');
    assert.deepEqual(ballinCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('fails unknown commands instead of ignoring them', () => {
    const result = runBackup({ args: ['typo'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "ballin backup: unknown command 'typo'\n");
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('fails unknown commands before checking Gist readability', () => {
    const result = runBackup({ args: ['typo'], ghInitialReadFail: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "ballin backup: unknown command 'typo'\n");
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reads a named Gist file', () => {
    seedFakeGistFile('vimrc', 'set number\n');

    const result = runBackup({ args: ['read', 'vimrc'] });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
    assert.deepEqual(gistReads(), ['vimrc']);
  });

  it('fails read when extra arguments are provided', () => {
    const result = runBackup({ args: ['read', 'vimrc', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup read: expected exactly one filename\n');
    assert.deepEqual(gistReads(), []);
  });

  it('streams large Gist files when reading a named file', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    seedFakeGistFile('vimrc', largeSnapshot);

    const result = runBackup({ args: ['read', 'vimrc'] });

    assertBackupSucceeded(result);
    assert.equal(result.stdout.length, largeSnapshot.length);
    assert.equal(result.stdout.slice(0, 1), 'r');
    assert.equal(result.stdout.slice(-1), '\n');
    assert.deepEqual(gistReads(), ['vimrc']);
  });

  it('prints options when a requested Gist file is missing', () => {
    const result = runBackup({ args: ['read', 'missing_file'] });

    assert.equal(result.status, 1);
    assert.include(result.stdout, '\nOptions: ');
    assert.include(result.stdout, 'ballin_config');
    assert.include(result.stdout, 'pipx');
    assert.include(result.stdout, 'uv_tools');
    assert.include(result.stdout, 'pyenv_versions');
    assert.include(result.stdout, 'vsI_settings');
    assert.deepEqual(gistReads(), ['missing_file']);
  });

  it('prints options when read is missing a filename', () => {
    const result = runBackup({ args: ['read'] });

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Error: 'read' needs a filename.");
    assert.include(result.stdout, '\nOptions: ');
    assert.include(result.stdout, 'pipx');
    assert.include(result.stdout, 'uv_tools');
    assert.include(result.stdout, 'pyenv_versions');
    assert.deepEqual(gistReads(), []);
  });

  it('reports a missing read filename before checking Gist readability', () => {
    const result = runBackup({ args: ['read'], ghInitialReadFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Error: 'read' needs a filename.");
    assert.include(result.stdout, '\nOptions: ');
    assert.equal(result.stderr, '');
    assert.deepEqual(gistReads(), []);
  });

  it('uses the initial Gist retrieval failure status before snapshotting', () => {
    const result = runBackup({ ghInitialReadFail: true });

    assert.equal(result.status, 17);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin self-update'.\n");
    assert.equal(result.stderr, 'simulated initial gh gist read failure\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('uses a shell-style signal exit status for initial Gist retrieval', () => {
    const result = runBackup({ ghInitialReadSignal: true });

    assert.equal(result.status, 143);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin self-update'.\n");
    assert.equal(result.stderr, '');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports gh authentication failures before snapshotting', () => {
    const result = runBackup({ ghAuthFail: true });

    assert.equal(result.status, 4);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'simulated gh auth failure\n'
        + 'ballin backup: GitHub CLI authentication is required for example.test\n'
        + "ballin backup: run 'gh auth login --hostname example.test'\n",
    );
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing gh before snapshotting', () => {
    removeGhCommand();

    const result = runBackup();

    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: command not found\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports permission-denied gh before snapshotting', () => {
    makeGhCommandPermissionDenied();

    const result = runBackup();

    assert.equal(result.status, 126);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: Permission denied\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('stops before snapshotting when config reads fail', () => {
    writeInvalidConfig();

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'ballin backup: missing config value backup.id\n');
    assert.include(result.stderr, 'ballin backup: missing config value backup.host\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing config reads before snapshotting', () => {
    removeConfig();

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'Unable to read');
    assert.include(result.stderr, 'ballin backup: missing config value backup.id\n');
    assert.include(result.stderr, 'ballin backup: missing config value backup.host\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing backup host before snapshotting', () => {
    writeBackupConfig('test-gist-id', null);

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: missing config value backup.host\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
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
      '💾 vs_settings',
      '💾 vs_keybindings',
      '💾 vs_extensions',
      '💾 vsI_settings',
      '💾 vsI_keybindings',
      '💾 vsI_extensions',
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
    assert.deepEqual(gistUploads(), [
      'vs_settings',
      'vs_keybindings',
      'vs_extensions',
      'vsI_settings',
      'vsI_keybindings',
      'vsI_extensions',
    ]);
  });

  it('snapshots Brackets settings, keymap, and extension directories', () => {
    const bracketsDir = path.join(testHomeDir, 'Library', 'Application Support', 'Brackets');
    fs.mkdirSync(path.join(bracketsDir, 'extensions', 'user'), { recursive: true });
    fs.mkdirSync(path.join(bracketsDir, 'extensions', 'disabled'), { recursive: true });
    fs.writeFileSync(path.join(bracketsDir, 'brackets.json'), '{"linting.enabled":true}\n');
    fs.writeFileSync(path.join(bracketsDir, 'keymap.json'), '{"Ctrl-E":"edit"}\n');
    fs.writeFileSync(path.join(bracketsDir, 'extensions', 'user', 'beautify'), '');
    fs.writeFileSync(path.join(bracketsDir, 'extensions', 'disabled', 'legacy-lint'), '');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '💾 brackets_settings',
      '💾 brackets_keymap',
      '💾 brackets_extensions',
      '💾 brackets_disabled_extensions',
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'brackets_settings.json'), 'utf8'),
      '{"linting.enabled":true}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'brackets_keymap.json'), 'utf8'),
      '{"Ctrl-E":"edit"}\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'brackets_extensions'), 'utf8'), 'beautify\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'brackets_disabled_extensions'), 'utf8'),
      'legacy-lint\n',
    );
    assert.deepEqual(gistUploads(), [
      'brackets_settings.json',
      'brackets_keymap.json',
      'brackets_extensions',
      'brackets_disabled_extensions',
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
      '💾 npm_global',
      '💾 mas',
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'npm_global'), 'utf8'),
      '/fake/npm\n+-- eslint@1.0.0\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'mas'), 'utf8'), '123456 Example App\n');
    assert.deepEqual(gistUploads(), ['npm_global', 'mas']);
  });

  it('skips Python tooling snapshots when commands are unavailable', () => {
    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
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
      '💾 pipx',
      '💾 uv_tools',
      '💾 pyenv_versions',
    ]);
    assert.deepEqual(pythonToolCalls(), [
      'pipx|list --json',
      'uv|tool list --show-version-specifiers --show-with --show-extras --show-python --no-progress --color never --no-config',
      'pyenv|versions --bare',
    ]);
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'pipx'), 'utf8'),
      '{"venvs":{"black":{"metadata":{"main_package":{"package":"black","package_version":"25.1.0"}}}}}\n',
    );
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'uv_tools'), 'utf8'), 'ruff v0.14.8 (Python 3.13.7)\n');
    assert.equal(fs.readFileSync(path.join(backupCacheDir, 'pyenv_versions'), 'utf8'), '3.12.12\n3.13.11\n');
    assert.deepEqual(gistUploads(), ['pipx', 'uv_tools', 'pyenv_versions']);
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
      assert.include(result.stdout, '💾 bash_completions\n');
      assert.equal(
        fs.readFileSync(path.join(backupCacheDir, 'bash_completions'), 'utf8'),
        'git\nnpm\n',
      );
      assert.equal(brewCalls().filter((call: string) => call.endsWith('|--prefix')).length, 1);
      assert.equal(gistUploads().filter((name: string) => name === 'bash_completions').length, 1);
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
    assert.equal(gistUploads().filter((name: string) => name === 'bash_completions').length, 1);
  });

  it('uses an explicit bash completion directory override when brew is unavailable', () => {
    const appleSiliconPrefix = path.join(testHomeDir, 'opt', 'homebrew');
    const completionDir = path.join(appleSiliconPrefix, 'etc', 'bash_completion.d');
    writeBashCompletions(appleSiliconPrefix, ['apple-silicon-tool']);

    const result = runBackup({ completionDir });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '💾 bash_completions\n');
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
    assert.equal(result.stdout, '');
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
      '💾 brew_list',
      '💾 brew_leaves',
      '💾 brew_cask',
      '💾 brew_services',
      '💾 Brewfile',
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
    assert.deepEqual(gistUploads(), [
      'brew_list',
      'brew_leaves',
      'brew_cask',
      'brew_services',
      'Brewfile',
    ]);
  });

  it('surfaces failed brew services stderr and preserves other inventory snapshots', () => {
    installFakeBrewCommand();

    const result = runBackup({ brewServicesFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'simulated services warning\n');
    assert.include(result.stderr, 'ballin backup: failed to snapshot brew_services\n');
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'brew_services')));
    assert.deepEqual(gistUploads(), [
      'brew_list',
      'brew_leaves',
      'brew_cask',
      'Brewfile',
    ]);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('creates and uploads the first snapshot when cache and Gist are missing', () => {
    writeSnapshot('alias hello="world"\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'alias hello="world"\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'alias hello="world"\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('uses the current new-file icon for a first empty snapshot', () => {
    writeSnapshot('');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'empty\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('hydrates a missing cache from unchanged Gist content', () => {
    writeSnapshot('export EDITOR=vim\n');
    seedFakeGist('export EDITOR=vim\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export EDITOR=vim\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
  });

  it('streams large Gist files when hydrating a missing cache', () => {
    const largeSnapshot = `${'h'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedFakeGist(largeSnapshot);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
  });

  it('compares against hydrated Gist content before uploading a change', () => {
    writeSnapshot('new value\n');
    seedFakeGist('old value\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new value\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('reports unchanged non-empty output without uploading it', () => {
    writeSnapshot('set -o vi\n');
    seedBackupCache('set -o vi\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.deepEqual(gistUploads(), []);
  });

  it('reports and uploads changed non-empty output', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('recreates a missing remote file when the local cache is warm', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');

    const result = runBackup({ ghEditMissingFile: true });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('reports a failure when a Gist upload fails', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');
    seedFakeGist('export COLOR=red\n');

    const result = runBackup({ ghUploadFail: true });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'simulated gh gist upload failure\nballin backup: failed to snapshot zshrc.sh\n');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=red\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=red\n');
    assert.deepEqual(gistUploads(), []);
  });

  it('retries a changed snapshot after a failed Gist upload', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');
    seedFakeGist('export COLOR=red\n');

    const failedResult = runBackup({ ghUploadFail: true });
    const retriedResult = runBackup();

    assert.equal(failedResult.status, 1);
    assertBackupSucceeded(retriedResult);
    assert.equal(retriedResult.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('streams large snapshot output without the default spawn buffer limit', () => {
    const largeSnapshot = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.equal(fs.statSync(fakeGistFilePath()).size, largeSnapshot.length);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('streams large snapshot stderr without the default spawn buffer limit', () => {
    writeAppSupportFile(['Code', 'User', 'settings.json'], '{}\n');
    writeTestExecutable('code', `#!/usr/bin/env bash
printf 'publisher.large-stderr\\n'
printf '%*s\\n' 1048577 '' >&2
`);

    const result = runBackup();

    assert.equal(result.status, 0);
    assert.include(result.stdout, '💾 vs_extensions\n');
    assert.equal(result.stderr.length, 1024 * 1024 + 2);
    assert.equal(result.stderr.slice(0, 1), ' ');
    assert.equal(result.stderr.slice(-1), '\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'vs_extensions'), 'utf8'),
      'publisher.large-stderr\n',
    );
    assert.include(gistUploads(), 'vs_extensions');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports and uploads non-empty output becoming empty', () => {
    writeSnapshot('');
    seedBackupCache('old content\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✖︎ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('hides unchanged empty output and does not upload it', () => {
    writeSnapshot('');
    seedBackupCache('empty\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(gistUploads(), []);
  });

  it('uses the new-file icon when empty becomes non-empty', () => {
    writeSnapshot('restored\n');
    seedBackupCache('empty\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('preserves multiple trailing blank lines', () => {
    writeSnapshot('line\n\n\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n\n\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'line\n\n\n');
  });

  it('normalizes output missing its final newline', () => {
    writeSnapshot('line');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'line\n');
  });

  it('uploads a normalized snapshot only once when a later run is unchanged', () => {
    writeSnapshot('stable without newline');

    const firstResult = runBackup();
    const secondResult = runBackup();

    assertBackupSucceeded(firstResult);
    assertBackupSucceeded(secondResult);
    assert.equal(secondResult.stdout, '✔ zshrc\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('preserves failed snapshot state, adds context, and continues later snapshots', () => {
    const gitconfigPath = path.join(testHomeDir, '.gitconfig');
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(gitconfigPath, 'new git value\n');
    seedBackupCache('old zsh value\n');
    seedFakeGist('old zsh value\n');

    const result = runBackup({
      failedPaths: ['.zshrc'],
      emitUnderlyingStderr: true,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '💾 gitconfig\n');
    assert.equal(
      result.stderr,
      'cat: simulated failure reading .zshrc\n'
        + 'ballin backup: failed to snapshot zshrc.sh\n',
    );
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old zsh value\n');
    assert.equal(
      fs.readFileSync(path.join(backupCacheDir, 'gitconfig'), 'utf8'),
      'new git value\n',
    );
    assert.deepEqual(gistUploads(), ['gitconfig']);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports a silent command failure without leaving failed Gist hydration behind', () => {
    writeSnapshot('not captured\n');

    const result = runBackup({ failedPaths: ['.zshrc'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: failed to snapshot zshrc.sh\n');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.isFalse(fs.existsSync(fakeGistFilePath()));
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('recovers cleanly on the next successful invocation', () => {
    writeSnapshot('recovered\n');
    seedBackupCache('before failure\n');
    seedFakeGist('before failure\n');

    const failedResult = runBackup({ failedPaths: ['.zshrc'] });
    const recoveredResult = runBackup();

    assert.equal(failedResult.status, 1);
    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'recovered\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'recovered\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('returns one predictable failure status after multiple snapshot failures', () => {
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
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });
});
