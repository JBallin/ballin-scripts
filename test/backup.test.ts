const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  ghInitialReadFail?: boolean;
  ghInitialReadSignal?: boolean;
  ghMetadataInvalid?: boolean;
  ghMetadataMode?: 'files-array' | 'files-null' | 'file-null' | 'truncated-string';
  ghFileTruncationInvalid?: boolean;
  ghFileSizeMode?: 'valid' | 'missing' | 'invalid' | 'mismatch';
  ghMetadataTruncated?: boolean;
  ghRawReadFailures?: string[];
  ghRawReadSignals?: string[];
  ghExpectedHost?: string;
  ghUploadAmbiguous?: boolean;
  ghUploadFail?: boolean;
  ghRemoveAfterAuth?: boolean;
  ghRemoveAfterInitialRead?: boolean;
  ghRemoveAfterMetadata?: boolean;
  commandPath?: string;
  commandCwd?: string;
  failFinalConfigCommit?: boolean;
  homeDirOverride?: string | null;
};

describe('ballin backup', () => {
  let testHomeDir: string;
  let testBinDir: string;
  let backupCacheDir: string;
  let configPath: string;
  let fakeGistDir: string;
  let gistReadLogPath: string;
  let gistRequestLogPath: string;
  let gistPayloadPath: string;
  let scratchDir: string;
  let gistUploadLogPath: string;
  let ghCommandLogPath: string;
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

  const writeBackupConfig = (id: unknown = 'test-gist-id', host: unknown = 'example.test') => {
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

  const writeCompleteBackupConfig = (id: unknown, host: unknown) => {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', '.defaultConfig.json'), 'utf8'));
    config.backup = { id, host };
    config.analytics.enabled = 'false';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  };

  const installFakeGhCommand = () => {
    // Store the fake remote Gist as ordinary files inside the temporary test home.
    writeTestExecutable('gh', `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GH_COMMAND_LOG"
if [ "$GH_HOST" != "$FAKE_GH_EXPECTED_HOST" ] && [ "$1:$2" != 'auth:status' ]; then
  printf '%s\\n' 'Unexpected GH_HOST' >&2
  exit 2
fi
if [ "$1:$2" = 'auth:status' ]; then
  if [ "$*" != "auth status --hostname $FAKE_GH_EXPECTED_HOST" ]; then
    printf '%s\\n' 'Unexpected gh auth arguments' >&2
    exit 2
  fi
  if [ "$FAKE_GH_AUTH_FAIL" = 'true' ]; then
    printf '%s\\n' 'simulated gh auth failure' >&2
    exit 4
  fi
  if [ "$FAKE_GH_REMOVE_AFTER_AUTH" = 'true' ]; then rm "$0"; fi
  exit 0
fi
if [ "$1" = 'api' ]; then
  if [ "$2" != '--hostname' ] || [ "$3" != "$FAKE_GH_EXPECTED_HOST" ] || [ "$4" != '--method' ]; then
    printf '%s\\n' 'Unexpected gh api routing arguments' >&2
    exit 2
  fi
  if [ "$6" != 'gists/test-gist-id' ]; then
    printf '%s\\n' 'Unexpected Gist API endpoint' >&2
    exit 2
  fi
  printf '%s\\n' "$*" >> "$FAKE_GH_REQUEST_LOG"
  if [ "$5" = 'GET' ] && [ "$#" -eq 6 ]; then
    if [ "$FAKE_GH_INITIAL_READ_FAIL" = 'true' ]; then
      printf '%s\\n' 'simulated initial gh gist read failure' >&2
      exit 17
    fi
    if [ "$FAKE_GH_INITIAL_READ_SIGNAL" = 'true' ]; then
      kill -TERM "$$"
    fi
    if [ "$FAKE_GH_METADATA_INVALID" = 'true' ]; then
      printf '%s\\n' '{invalid'
      exit 0
    fi
    if [ "$FAKE_GH_METADATA_MODE" = 'files-array' ]; then printf '%s\\n' '{"files":[]}'; exit 0; fi
    if [ "$FAKE_GH_METADATA_MODE" = 'files-null' ]; then printf '%s\\n' '{"files":null}'; exit 0; fi
    if [ "$FAKE_GH_METADATA_MODE" = 'truncated-string' ]; then printf '%s\\n' '{"files":{},"truncated":"yes"}'; exit 0; fi
    node -e 'const fs = require("fs"); const path = require("path"); const dir = process.argv[1]; const files = {}; const sizeMode = process.env.FAKE_GH_FILE_SIZE_MODE; for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (!fs.statSync(file).isFile()) continue; const size = fs.statSync(file).size; files[name] = process.env.FAKE_GH_METADATA_MODE === "file-null" ? null : { filename: name, ...(sizeMode === "missing" ? {} : { size: sizeMode === "invalid" ? "invalid" : sizeMode === "mismatch" ? size + 1 : size }), truncated: process.env.FAKE_GH_FILE_TRUNCATION_INVALID === "true" ? "invalid" : size > 1048576, ...(size > 1048576 ? {} : { content: fs.readFileSync(file, "utf8") }) }; } process.stdout.write(JSON.stringify({ files, truncated: process.env.FAKE_GH_METADATA_TRUNCATED === "true" }) + "\\n");' "$FAKE_GIST_STORAGE_DIR"
    metadata_status=$?
    if [ "$FAKE_GH_REMOVE_AFTER_METADATA" = 'true' ]; then rm "$0"; fi
    exit "$metadata_status"
  fi
  if [ "$5" = 'PATCH' ] && [ "$7" = '--input' ] && [ "$9" = '--silent' ] && [ "$#" -eq 9 ]; then
    if [ "$FAKE_GH_UPLOAD_FAIL" = 'true' ]; then
      printf '%s\\n' 'simulated gh api upload failure' >&2
      exit 19
    fi
    cp "$8" "$FAKE_GH_PAYLOAD_PATH"
    node -e 'const fs = require("fs"); const path = require("path"); const [payloadPath, dir, log] = process.argv.slice(1); const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8")); if (!payload.files || Array.isArray(payload.files)) throw new Error("missing files payload"); for (const [name, value] of Object.entries(payload.files)) { if (value === null || typeof value !== "object" || typeof value.content !== "string") throw new Error("invalid file payload"); fs.writeFileSync(path.join(dir, name), value.content); fs.appendFileSync(log, name + "\\n"); }' "$8" "$FAKE_GIST_STORAGE_DIR" "$FAKE_GIST_UPLOAD_LOG"
    patch_status=$?
    if [ "$patch_status" -ne 0 ]; then exit "$patch_status"; fi
    if [ "$FAKE_GH_UPLOAD_AMBIGUOUS" = 'true' ]; then
      kill -TERM "$$"
    fi
    exit 0
  fi
  printf '%s\\n' 'Unexpected gh api arguments' >&2
  exit 2
fi
if [ "$1:$2" != 'gist:view' ]; then
  printf '%s\\n' 'Unexpected gh call' >&2
  exit 2
fi
if [ "$3:$4:$5" = '--files:--:test-gist-id' ]; then
  for fake_gist_file in "$FAKE_GIST_STORAGE_DIR"/*; do
    if [ -f "$fake_gist_file" ]; then
      printf '%s\n' "\${fake_gist_file##*/}"
    fi
  done
  exit 0
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
    if [ "$FAKE_GH_REMOVE_AFTER_INITIAL_READ" = 'true' ]; then rm "$0"; fi
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
  IFS=':' read -r -a raw_read_failures <<< "$FAKE_GH_RAW_READ_FAILURES"
  for failed_file in "\${raw_read_failures[@]}"; do
    if [ -n "$failed_file" ] && [ "$6" = "$failed_file" ]; then
      printf '%s\\n' 'simulated raw Gist read failure' >&2
      exit 21
    fi
  done
  IFS=':' read -r -a raw_read_signals <<< "$FAKE_GH_RAW_READ_SIGNALS"
  for signaled_file in "\${raw_read_signals[@]}"; do
    if [ -n "$signaled_file" ] && [ "$6" = "$signaled_file" ]; then
      kill -TERM "$$"
    fi
  done
  fake_gist_file="$FAKE_GIST_STORAGE_DIR/$6"
  if [ -f "$fake_gist_file" ]; then
    cat "$fake_gist_file"
  else
    exit 1
  fi
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
    gistRequestLogPath = path.join(testHomeDir, 'fake-gist-requests.log');
    gistPayloadPath = path.join(testHomeDir, 'fake-gist-payload.json');
    scratchDir = path.join(testHomeDir, 'tmp');
    gistUploadLogPath = path.join(testHomeDir, 'fake-gist-uploads.log');
    ghCommandLogPath = path.join(testHomeDir, 'fake-gh-commands.log');
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
    fs.cpSync(path.join(repoRoot, 'config'), path.join(testHomeDir, '.ballin-scripts', 'config'), {
      recursive: true,
    });
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
    input,
    failedPaths = [],
    emitUnderlyingStderr = false,
    brewServicesFail = false,
    brewPrefix = path.join(testHomeDir, 'opt', 'homebrew'),
    brewPrefixFail = false,
    completionDir,
    ghAuthFail = false,
    ghInitialReadFail = false,
    ghInitialReadSignal = false,
    ghMetadataInvalid = false,
    ghMetadataMode,
    ghFileTruncationInvalid = false,
    ghFileSizeMode = 'valid',
    ghMetadataTruncated = false,
    ghRawReadFailures = [],
    ghRawReadSignals = [],
    ghExpectedHost = 'example.test',
    ghUploadAmbiguous = false,
    ghUploadFail = false,
    ghRemoveAfterAuth = false,
    ghRemoveAfterInitialRead = false,
    ghRemoveAfterMetadata = false,
    commandPath = ballinPath,
    commandCwd = testHomeDir,
    failFinalConfigCommit = false,
    homeDirOverride = testHomeDir,
  }: RunBackupOptions = {}) => spawnSync(commandPath, ['backup', ...args], {
    cwd: commandCwd,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...(homeDirOverride === null ? {} : { HOME: homeDirOverride }),
      PATH: testBinDir,
      TMPDIR: scratchDir,
      ...(completionDir === undefined ? {} : {
        BALLIN_BACKUP_BASH_COMPLETION_DIR: completionDir,
      }),
      BALLIN_TEST_CONFIG_PATH: configPath,
      BALLIN_TEST_REPO_DIR: path.join(testHomeDir, '.ballin-scripts'),
      BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: failFinalConfigCommit ? '1' : '0',
      BALLIN_NO_ANALYTICS: '1',
      FAKE_GIST_STORAGE_DIR: fakeGistDir,
      FAKE_GIST_READ_LOG: gistReadLogPath,
      FAKE_GIST_UPLOAD_LOG: gistUploadLogPath,
      FAKE_GH_REQUEST_LOG: gistRequestLogPath,
      FAKE_GH_PAYLOAD_PATH: gistPayloadPath,
      FAKE_GH_COMMAND_LOG: ghCommandLogPath,
      FAKE_GH_WEB_LOG: openLogPath,
      FAKE_GH_EXPECTED_HOST: ghExpectedHost,
      FAKE_GH_AUTH_FAIL: ghAuthFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_FAIL: ghInitialReadFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_SIGNAL: ghInitialReadSignal ? 'true' : 'false',
      FAKE_GH_METADATA_INVALID: ghMetadataInvalid ? 'true' : 'false',
      FAKE_GH_METADATA_MODE: ghMetadataMode ?? '',
      FAKE_GH_FILE_TRUNCATION_INVALID: ghFileTruncationInvalid ? 'true' : 'false',
      FAKE_GH_FILE_SIZE_MODE: ghFileSizeMode,
      FAKE_GH_METADATA_TRUNCATED: ghMetadataTruncated ? 'true' : 'false',
      FAKE_GH_RAW_READ_FAILURES: ghRawReadFailures.join(':'),
      FAKE_GH_RAW_READ_SIGNALS: ghRawReadSignals.join(':'),
      FAKE_GH_UPLOAD_AMBIGUOUS: ghUploadAmbiguous ? 'true' : 'false',
      FAKE_GH_UPLOAD_FAIL: ghUploadFail ? 'true' : 'false',
      FAKE_GH_REMOVE_AFTER_AUTH: ghRemoveAfterAuth ? 'true' : 'false',
      FAKE_GH_REMOVE_AFTER_INITIAL_READ: ghRemoveAfterInitialRead ? 'true' : 'false',
      FAKE_GH_REMOVE_AFTER_METADATA: ghRemoveAfterMetadata ? 'true' : 'false',
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
  const cachedFilePath = (fileName: string) => path.join(backupCacheDir, fileName);
  const cachedSnapshotPath = () => cachedFilePath(snapshotFileName);
  const fakeGistFilePath = () => path.join(fakeGistDir, snapshotFileName);
  const writeSnapshot = (content: string) => fs.writeFileSync(snapshotPath(), content);
  const seedFakeGist = (content: string) => fs.writeFileSync(fakeGistFilePath(), content);
  const seedBackupCache = (content: string, seedRemote = true) => {
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), content);
    if (seedRemote) {
      seedFakeGist(content);
    }
  };
  const seedFakeGistFile = (fileName: string, content: string) => {
    fs.writeFileSync(path.join(fakeGistDir, fileName), content);
  };
  const seedBackupMarker = () => seedFakeGistFile(
    '.MyConfig.md',
    '### Backup of your dev environment\n'
      + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n\n',
  );
  const seedCacheFile = (fileName: string, content: string, seedRemote = true) => {
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedFilePath(fileName), content);
    if (seedRemote) {
      seedFakeGistFile(fileName, content);
    }
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
  const ghCalls = () => readLogLines(ghCommandLogPath);
  const gistRequests = () => readLogLines(gistRequestLogPath);
  const gistPatchCalls = () => gistRequests().filter((call: string) => call.includes('--method PATCH'));
  const gistPayload = () => JSON.parse(fs.readFileSync(gistPayloadPath, 'utf8'));
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
    assert.include(result.stderr, 'Unable to read config:');
    assert.notInclude(result.stderr, 'ballin backup setup');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('rejects non-object configuration before any GitHub operation', () => {
    ['[]\n', 'null\n', '{"backup":[]}\n'].forEach((config) => {
      fs.writeFileSync(configPath, config);
      const result = runBackup();

      assert.equal(result.status, 1);
      assert.equal(result.stderr, 'ballin backup: configuration must contain JSON objects\n');
    });
    assert.deepEqual(ghCalls(), []);
  });

  it('treats a default null Gist ID as missing when opening', () => {
    writeBackupConfig(null);

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "ballin backup: backup is not configured; run 'ballin backup setup' to enable it\n");
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('rejects malformed backup IDs without using GitHub', () => {
    [42, ['unexpected-id'], { value: 'unexpected-id' }].forEach((id) => {
      writeBackupConfig(id);

      const result = runBackup();

      assert.equal(result.status, 1);
      assert.include(result.stderr, 'ballin backup: invalid config value backup.id; expected null or a non-empty string');
      assert.include(result.stderr, 'run ballin config reset to restore valid defaults');
    });
    assert.deepEqual(ghCalls(), []);
  });

  it('rejects non-string backup hosts for configured IDs without using GitHub', () => {
    [42, false, ['unexpected-host'], { value: 'unexpected-host' }].forEach((host) => {
      writeBackupConfig('test-gist-id', host);

      const result = runBackup();

      assert.equal(result.status, 1);
      assert.include(result.stderr, 'missing or invalid config value backup.host');
      assert.include(result.stderr, 'run ballin backup setup to repair it');
    });
    assert.deepEqual(ghCalls(), []);
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

  it('reports unexpected gh spawn failures without masking the underlying error', () => {
    fs.rmSync(path.join(testBinDir, 'gh'));
    fs.symlinkSync('gh', path.join(testBinDir, 'gh'));

    const result = runBackup({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'ELOOP');
    assert.deepEqual(openCalls(), []);
  });

  it('reports when gh disappears after authentication but before opening the Gist', () => {
    const result = runBackup({ args: ['open'], ghRemoveAfterAuth: true });

    assert.equal(result.status, 127);
    assert.include(result.stderr, 'gh: command not found');
    assert.isFalse(fs.existsSync(openLogPath));
  });

  it('prints help through the ballin command', () => {
    const result = runBackup({ args: ['help'] });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'ballin backup');
    assert.include(result.stdout, 'setup');
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

  it('rejects extra setup arguments before using GitHub', () => {
    writeBackupConfig(null);

    const result = runBackup({ args: ['setup', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup setup: expected no arguments\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistRequests(), []);
  });

  it('rejects malformed config before prompting or using GitHub during setup', () => {
    writeInvalidConfig();

    const result = runBackup({ args: ['setup'] });

    assert.equal(result.status, 1);
    assert.notInclude(result.stdout, 'Set up optional Gist backups now?');
    assert.include(result.stderr, 'ballin backup setup: unable to create or update config');
    assert.deepEqual(ghCalls(), []);
  });

  it('rejects malformed backup IDs during standalone setup without mutation or GitHub work', () => {
    [42, ['unexpected-id'], { value: 'unexpected-id' }].forEach((id) => {
      writeCompleteBackupConfig(id, 'example.test');
      seedBackupCache('preserve invalid destination cache\n', false);
      const previousConfig = fs.readFileSync(configPath, 'utf8');

      const result = runBackup({ args: ['setup'], input: 'y\n' });

      assert.equal(result.status, 1);
      assert.include(result.stdout, 'Invalid config value backup.id; expected null or a non-empty string.');
      assert.include(result.stdout, 'Run ballin config reset to restore valid defaults');
      assert.notInclude(result.stdout, 'Set up optional Gist backups now?');
      assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve invalid destination cache\n');
      fs.rmSync(backupCacheDir, { recursive: true, force: true });
    });
    assert.deepEqual(ghCalls(), []);
    assert.deepEqual(gistRequests(), []);
  });

  it('validates the retained Gist before repairing a malformed host to GitHub.com', () => {
    writeCompleteBackupConfig('test-gist-id', { value: 'unexpected-host' });
    seedBackupCache('preserve configured cache\n', false);
    seedBackupMarker();

    const result = runBackup({
      args: ['setup'],
      ghExpectedHost: 'github.com',
      input: '\n',
    });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Invalid config value backup.host; expected a non-empty string.');
    assert.include(result.stdout, 'What GitHub host should be used for Gist backups? [github.com]');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.host, 'github.com');
    assert.deepEqual(ghCalls(), [
      'auth status --hostname github.com',
      'gist view test-gist-id --raw --filename .MyConfig.md',
    ]);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
  });

  it('validates the retained Gist before repairing a malformed host to Enterprise', () => {
    writeCompleteBackupConfig('test-gist-id', { value: 'unexpected-host' });
    seedBackupCache('preserve configured cache\n', false);
    seedBackupMarker();

    const result = runBackup({
      args: ['setup'],
      ghExpectedHost: 'github.enterprise.test',
      input: 'github.enterprise.test\n',
    });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Invalid config value backup.host; expected a non-empty string.');
    assert.include(result.stdout, 'What GitHub host should be used for Gist backups? [github.com]');
    assert.equal(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.host,
      'github.enterprise.test',
    );
    assert.deepEqual(ghCalls(), [
      'auth status --hostname github.enterprise.test',
      'gist view test-gist-id --raw --filename .MyConfig.md',
    ]);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
  });

  it('does not persist a repaired host when the retained Gist marker is missing or wrong', () => {
    [null, 'not a Ballin backup\n'].forEach((marker) => {
      fs.rmSync(ghCommandLogPath, { force: true });
      fs.rmSync(gistReadLogPath, { force: true });
      fs.rmSync(fakeGistDir, { recursive: true, force: true });
      fs.rmSync(backupCacheDir, { recursive: true, force: true });
      fs.mkdirSync(fakeGistDir, { recursive: true });
      writeCompleteBackupConfig('test-gist-id', { value: 'unexpected-host' });
      seedBackupCache('preserve configured cache\n', false);
      if (marker !== null) {
        seedFakeGistFile('.MyConfig.md', marker);
      }
      const previousConfig = fs.readFileSync(configPath, 'utf8');

      const result = runBackup({
        args: ['setup'],
        ghExpectedHost: 'github.enterprise.test',
        input: 'github.enterprise.test\n',
      });

      assert.equal(result.status, 1);
      assert.include(result.stdout, "Gist 'test-gist-id' on github.enterprise.test is not a valid Ballin backup destination.");
      assert.include(result.stdout, 'The existing backup.host was not changed.');
      assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
      assert.deepEqual(ghCalls(), [
        'auth status --hostname github.enterprise.test',
        'gist view test-gist-id --raw --filename .MyConfig.md',
      ]);
    });
  });

  it('prompts for a legacy configured backup host before accepting a migrated default', () => {
    writeBackupConfig('test-gist-id', null);
    seedBackupCache('preserve configured cache\n', false);

    const result = runBackup({
      args: ['setup'],
      ghExpectedHost: 'github.enterprise.test',
      input: 'github.enterprise.test\n',
    });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'What GitHub host should be used for Gist backups? [github.com]');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.backup.id, 'test-gist-id');
    assert.equal(config.backup.host, 'github.enterprise.test');
    assert.deepEqual(ghCalls(), ['auth status --hostname github.enterprise.test']);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
  });

  it('preserves an existing Enterprise host without re-prompting standalone setup', () => {
    writeBackupConfig('test-gist-id', 'github.enterprise.test');
    seedBackupCache('preserve configured cache\n', false);

    const result = runBackup({
      args: ['setup'],
      ghExpectedHost: 'github.enterprise.test',
    });

    assertBackupSucceeded(result);
    assert.notInclude(result.stdout, 'What GitHub host should be used for Gist backups?');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.backup.id, 'test-gist-id');
    assert.equal(config.backup.host, 'github.enterprise.test');
    assert.deepEqual(ghCalls(), ['auth status --hostname github.enterprise.test']);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
  });

  it('offers automatic update backups after standalone setup adopts a destination', () => {
    writeCompleteBackupConfig(null, 'example.test');
    seedBackupMarker();
    const restoredConfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'config', '.defaultConfig.json'), 'utf8'),
    );
    restoredConfig.update.backup = 'false';
    seedFakeGistFile('ballin_config', JSON.stringify(restoredConfig));

    const result = runBackup({
      args: ['setup'],
      input: 'y\n\ny\ntest-gist-id\ny\n',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.include(result.stdout, 'Automatically run ballin backup after ballin update? [y/N]');
    assert.notInclude(result.stdout, 'Automatic update backups unchanged.');
    const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(configured.backup.id, 'test-gist-id');
    assert.equal(configured.update.backup, 'true');
  });

  it('preserves a declined automatic-backup preference after standalone adoption', () => {
    writeCompleteBackupConfig(null, 'example.test');
    seedBackupMarker();
    const restoredConfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'config', '.defaultConfig.json'), 'utf8'),
    );
    restoredConfig.update.backup = 'false';
    seedFakeGistFile('ballin_config', JSON.stringify(restoredConfig));

    const result = runBackup({
      args: ['setup'],
      input: 'y\n\ny\ntest-gist-id\nn\n',
    });

    assertBackupSucceeded(result);
    assert.include(result.stdout, 'Automatically run ballin backup after ballin update? [y/N]');
    assert.include(result.stdout, 'Automatic update backups unchanged. Enable later with: ballin config set update.backup true');
    const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(configured.backup.id, 'test-gist-id');
    assert.equal(configured.update.backup, 'false');
  });

  it('reports failure when an accepted automatic-backup choice cannot be persisted', () => {
    writeCompleteBackupConfig(null, 'example.test');
    seedBackupMarker();
    const restoredConfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'config', '.defaultConfig.json'), 'utf8'),
    );
    restoredConfig.update.backup = { invalid: true };
    seedFakeGistFile('ballin_config', JSON.stringify(restoredConfig));

    const result = runBackup({
      args: ['setup'],
      input: 'y\n\ny\ntest-gist-id\ny\n',
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Automatically run ballin backup after ballin update? [y/N]');
    assert.include(result.stdout, 'Backup setup completed, but automatic update backups were not enabled. Edit ballin.config.json and set update.backup to true.');
    assert.notInclude(result.stdout, 'Enable later with: ballin config set update.backup true');
    assert.include(result.stderr, "setup did not complete; resolve the error and retry with 'ballin backup setup'");
    const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(configured.backup.id, 'test-gist-id');
    assert.deepEqual(configured.update.backup, { invalid: true });
  });

  it('uses the executing checkout cache after setup with mismatched HOME', () => {
    const staleRemoteBase = 'old destination value\n';
    const localValue = 'local value for adopted destination\n';
    const alternateHome = path.join(testHomeDir, 'alternate-home');
    const alternateCache = path.join(alternateHome, '.ballin-scripts', '.backup-cache');
    writeBackupConfig(null);
    seedBackupCache('checkout stale base\n', false);
    fs.mkdirSync(alternateCache, { recursive: true });
    fs.writeFileSync(path.join(alternateCache, snapshotFileName), staleRemoteBase);
    seedFakeGist(staleRemoteBase);
    seedBackupMarker();

    const result = runBackup({
      args: ['setup'],
      homeDirOverride: alternateHome,
      input: 'y\n\ny\ntest-gist-id\n',
    });

    assertBackupSucceeded(result);
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.equal(fs.readFileSync(path.join(alternateCache, snapshotFileName), 'utf8'), staleRemoteBase);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.id, 'test-gist-id');

    fs.writeFileSync(path.join(alternateHome, '.zshrc'), localValue);
    const backupResult = runBackup({ homeDirOverride: alternateHome });

    assert.equal(backupResult.status, 1);
    assert.include(backupResult.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.deepEqual(gistPatchCalls(), []);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), staleRemoteBase);
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.equal(
      fs.readFileSync(path.join(alternateCache, snapshotFileName), 'utf8'),
      staleRemoteBase,
    );
  });

  it('never consults a relative cache when HOME is unset', () => {
    const staleRemoteBase = 'old destination value\n';
    const commandCwd = path.join(testHomeDir, 'unrelated-cwd');
    const relativeCache = path.join(commandCwd, '.ballin-scripts', '.backup-cache');
    writeBackupConfig(null);
    seedBackupCache('checkout stale base\n', false);
    fs.mkdirSync(relativeCache, { recursive: true });
    fs.writeFileSync(path.join(relativeCache, snapshotFileName), staleRemoteBase);
    seedFakeGist(staleRemoteBase);
    seedBackupMarker();

    const result = runBackup({
      args: ['setup'],
      commandCwd,
      homeDirOverride: null,
      input: 'y\n\ny\ntest-gist-id\n',
    });

    assertBackupSucceeded(result);
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.id, 'test-gist-id');
    const setupGhCalls = ghCalls();

    fs.writeFileSync(path.join(commandCwd, '.zshrc'), 'local value for adopted destination\n');
    const backupResult = runBackup({ commandCwd, homeDirOverride: null });

    assert.equal(backupResult.status, 1);
    assert.equal(
      backupResult.stderr,
      'ballin backup: HOME is not set; unable to collect backup sources safely\n',
    );
    assert.deepEqual(ghCalls(), setupGhCalls);
    assert.deepEqual(gistPatchCalls(), []);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), staleRemoteBase);
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.equal(
      fs.readFileSync(path.join(relativeCache, snapshotFileName), 'utf8'),
      staleRemoteBase,
    );
  });

  it('cancels adopted Gist setup on empty or EOF input without looping', () => {
    writeCompleteBackupConfig(null, 'example.test');

    const result = runBackup({
      args: ['setup'],
      input: 'y\n\ny\n',
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Backup Gist adoption cancelled; no destination was configured');
    assert.notInclude(result.stdout, 'Automatically run ballin backup after ballin update?');
    assert.include(result.stderr, "retry with 'ballin backup setup'");
    assert.isNull(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.id);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).update.backup, 'false');
    assert.notInclude(ghCalls().join('\n'), 'gist view');
  });

  it('reports public setup failure and preserves exact config when the final adoption commit fails', () => {
    const originalConfig = `${JSON.stringify({
      update: {
        cleanup: 'false',
        selfUpdate: 'true',
        backup: 'false',
        softwareupdate: 'false',
        npm: 'false',
        nvm: 'false',
      },
      backup: { id: null, host: 'example.test' },
      analytics: { enabled: 'false' },
      local: { keep: 'exactly' },
    }, null, 2)}\n`;
    fs.writeFileSync(configPath, originalConfig);
    seedBackupCache('checkout stale base\n', false);
    seedBackupMarker();
    seedFakeGistFile('ballin_config', JSON.stringify({
      backup: { id: 'snapshot-gist-id', host: 'snapshot.example.test' },
      analytics: { enabled: 'false' },
    }));

    const result = runBackup({
      args: ['setup'],
      failFinalConfigCommit: true,
      input: 'y\n\ny\ntest-gist-id\n',
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, "retry with 'ballin backup setup'");
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.notInclude(ghCalls().join('\n'), 'snapshot.example.test');
    assert.notInclude(ghCalls().join('\n'), 'snapshot-gist-id');
  });

  it('invalidates stale cache before adoption so it cannot authorize a later upload', () => {
    const staleRemoteBase = 'old destination value\n';
    const localValue = 'local value for adopted destination\n';
    writeBackupConfig(null);
    seedBackupCache(staleRemoteBase, false);
    seedFakeGist(staleRemoteBase);
    seedBackupMarker();
    seedFakeGistFile('ballin_config', JSON.stringify({
      update: {
        cleanup: 'false',
        selfUpdate: 'true',
        backup: 'false',
        softwareupdate: 'false',
        npm: 'false',
        nvm: 'false',
      },
      backup: {
        id: 'snapshot-destination-id',
        host: 'snapshot.example.test',
      },
      analytics: { enabled: 'false' },
    }));

    const setupResult = runBackup({
      args: ['setup'],
      input: 'y\n\ny\ntest-gist-id\n',
    });

    assertBackupSucceeded(setupResult);
    const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(configured.backup.host, 'example.test');
    assert.equal(configured.backup.id, 'test-gist-id');
    assert.isFalse(fs.existsSync(backupCacheDir));

    writeSnapshot(localValue);
    const backupResult = runBackup();

    assert.equal(backupResult.status, 1);
    assert.include(backupResult.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.deepEqual(gistPatchCalls(), []);
    assert.deepEqual(gistUploads(), []);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), staleRemoteBase);
    assert.isFalse(fs.existsSync(backupCacheDir));
  });

  it('leaves backup unconfigured and prevents Gist creation when cache invalidation fails', () => {
    writeBackupConfig(null);
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), 'unproven cache\n');
    const cacheParent = path.dirname(backupCacheDir);
    fs.chmodSync(cacheParent, 0o555);

    let result: StringSpawnResult;
    try {
      result = runBackup({
        args: ['setup'],
        input: 'y\n\nn\n',
      });
    } finally {
      fs.chmodSync(cacheParent, 0o755);
    }

    assert.equal(result.status, 1);
    assert.include(result.stdout, `Unable to invalidate ${backupCacheDir}`);
    assert.isNull(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.id);
    assert.isTrue(fs.existsSync(backupCacheDir));
    assert.notInclude(ghCalls().join('\n'), 'gist create');
    assert.notInclude(ghCalls().join('\n'), 'gist view');
  });

  it('prevents adopted config restoration when cache invalidation fails', () => {
    writeBackupConfig(null);
    fs.mkdirSync(backupCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), 'unproven cache\n');
    seedFakeGistFile(
      '.MyConfig.md',
      '### Backup of your dev environment\n'
        + 'Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)\n\n',
    );
    seedFakeGistFile('ballin_config', JSON.stringify({
      backup: { id: 'snapshot-id', host: 'snapshot.example.test' },
    }));
    const cacheParent = path.dirname(backupCacheDir);
    fs.chmodSync(cacheParent, 0o555);

    let result: StringSpawnResult;
    try {
      result = runBackup({
        args: ['setup'],
        input: 'y\n\ny\ntest-gist-id\n',
      });
    } finally {
      fs.chmodSync(cacheParent, 0o755);
    }

    assert.equal(result.status, 1);
    assert.include(result.stdout, `Unable to invalidate ${backupCacheDir}`);
    assert.isNull(JSON.parse(fs.readFileSync(configPath, 'utf8')).backup.id);
    assert.isTrue(fs.existsSync(backupCacheDir));
    assert.include(ghCalls().join('\n'), 'gist view test-gist-id --raw --filename .MyConfig.md');
    assert.notInclude(ghCalls().join('\n'), '--filename ballin_config');
    assert.notInclude(ghCalls().join('\n'), 'gist create');
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
    assert.include(result.stdout, 'Brewfile');
    assert.include(result.stdout, 'gitconfig');
    assert.notInclude(result.stdout, 'git_config');
    assert.notInclude(result.stdout, 'gitconfig.cson');
    assert.include(result.stdout, 'pipx');
    assert.include(result.stdout, 'uv_tools');
    assert.include(result.stdout, 'pyenv_versions');
    assert.include(result.stdout, 'vsI_settings');
    assert.deepEqual(gistReads(), ['missing_file']);
  });

  it('fails a read before output when Gist readability cannot be verified', () => {
    const result = runBackup({ args: ['read', 'vimrc'], ghInitialReadFail: true });

    assert.equal(result.status, 17);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin self-update'.\n");
    assert.include(result.stderr, 'simulated initial gh gist read failure');
    assert.deepEqual(gistReads(), []);
  });

  it('fails a read safely when gh disappears after authentication', () => {
    const result = runBackup({ args: ['read', 'vimrc'], ghRemoveAfterAuth: true });

    assert.equal(result.status, 127);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin self-update'.\n");
    assert.equal(result.stderr, 'gh: command not found\n');
    assert.deepEqual(gistReads(), []);
  });

  it('fails a read safely when gh disappears after verifying the Gist', () => {
    const result = runBackup({
      args: ['read', 'vimrc'],
      ghRemoveAfterInitialRead: true,
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'gh: command not found');
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

  it('stages locally before a Gist metadata failure without mutating cache or remote state', () => {
    writeSnapshot('staged locally\n');
    const result = runBackup({ ghInitialReadFail: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'simulated initial gh gist read failure\n'
        + 'ballin backup: failed to read current Gist state\n',
    );
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports temp-file staging failures without reading or mutating the Gist', () => {
    writeSnapshot('local value\n');
    fs.rmSync(scratchDir, { recursive: true });
    fs.writeFileSync(scratchDir, 'not a temp directory\n');

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.include(result.stderr, `unable to stage ${snapshotFileName}`);
    assert.include(result.stderr, `failed to snapshot ${snapshotFileName}`);
    assert.deepEqual(gistRequests(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports collector spawn failures and leaves remote and cache state untouched', () => {
    writeSnapshot('local value\n');
    fs.rmSync(path.join(testBinDir, 'cat'));
    fs.symlinkSync('cat', path.join(testBinDir, 'cat'));

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'ELOOP');
    assert.include(result.stderr, `failed to snapshot ${snapshotFileName}`);
    assert.deepEqual(gistRequests(), []);
    assert.deepEqual(gistUploads(), []);
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
  });

  it('fails closed when gh disappears before Gist metadata is read', () => {
    const result = runBackup({ ghRemoveAfterAuth: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'gh: command not found');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.equal(fs.readdirSync(fakeGistDir).length, 0);
  });

  it('treats an interrupted Gist metadata read as a failed closed run', () => {
    writeSnapshot('new local value\n');
    seedBackupCache('cached base\n');
    const result = runBackup({ ghInitialReadSignal: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: failed to read current Gist state\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'cached base\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'cached base\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('preserves remote and cache state when gh disappears before a truncated remote read', () => {
    const remoteContent = `${'remote content\n'.repeat(80000)}`;
    writeSnapshot('local content\n');
    seedFakeGist(remoteContent);

    const result = runBackup({ ghRemoveAfterMetadata: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'gh: command not found');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), remoteContent);
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.deepEqual(gistUploads(), []);
  });

  it('preserves remote and cache state when gh disappears before the Gist update', () => {
    writeSnapshot('new local content\n');

    const result = runBackup({ ghRemoveAfterMetadata: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'gh: command not found');
    assert.include(result.stderr, 'Gist update failed or its outcome is unknown');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
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
    assert.include(result.stderr, 'Unable to read config:');
    assert.notInclude(result.stderr, 'ballin backup setup');
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
    assert.notInclude(result.stderr, 'ballin backup setup');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing backup host before snapshotting', () => {
    writeBackupConfig('test-gist-id', null);

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'missing or invalid config value backup.host');
    assert.include(result.stderr, 'run ballin backup setup to repair it');
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
      '✚ vs_settings',
      '✚ vs_keybindings',
      '✚ vs_extensions',
      '✚ vsI_settings',
      '✚ vsI_keybindings',
      '✚ vsI_extensions',
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
      '✚ npm_global',
      '✚ mas',
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
      '✚ pipx',
      '✚ uv_tools',
      '✚ pyenv_versions',
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
      assert.include(result.stdout, '✚ bash_completions\n');
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
    assert.equal(result.stdout, '✚ bash_completions\n');
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
      '✚ brew_list',
      '✚ brew_leaves',
      '✚ brew_cask',
      '✚ brew_services',
      '✚ Brewfile',
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

  it('surfaces a failed collector and commits none of the other staged inventories', () => {
    installFakeBrewCommand();

    const result = runBackup({ brewServicesFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'simulated services warning\n');
    assert.include(result.stderr, 'ballin backup: failed to snapshot brew_services\n');
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(fakeGistDir), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('creates and uploads the first snapshot when cache and Gist are missing', () => {
    writeSnapshot('alias hello="world"\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'alias hello="world"\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'alias hello="world"\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('reports cache preparation failure only after a known successful remote update', () => {
    writeSnapshot('new remote value\n');
    fs.writeFileSync(backupCacheDir, 'blocks cache directory creation\n');

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'failed to prepare backup cache updates');
    assert.include(result.stderr, 'the Gist outcome is known, but one or more cache updates failed');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new remote value\n');
    assert.equal(fs.readFileSync(backupCacheDir, 'utf8'), 'blocks cache directory creation\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('uses the final new-file marker for a first empty snapshot', () => {
    writeSnapshot('');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'empty\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
    assert.deepEqual(gistPayload(), {
      files: { [snapshotFileName]: { content: 'empty\n' } },
    });
    assert.notInclude(JSON.stringify(gistPayload()), 'null');
  });

  it('hydrates a missing cache from unchanged Gist content', () => {
    writeSnapshot('export EDITOR=vim\n');
    seedFakeGist('export EDITOR=vim\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export EDITOR=vim\n');
    assert.deepEqual(gistReads(), []);
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
      }
      if (testCase.remote !== null) {
        seedFakeGist(testCase.remote);
      }

      const result = runBackup();

      assert.equal(result.status, testCase.expectedStatus);
      assert.equal(result.stdout, testCase.expectedOutput);
      assert.deepEqual(gistUploads(), testCase.uploads);
      if (testCase.expectedStatus === 0) {
        assert.equal(result.stderr, '');
        assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), testCase.local);
        assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), testCase.local);
      } else {
        assert.include(result.stderr, `ballin backup: conflict for ${snapshotFileName}`);
        if (testCase.base === null) {
          assert.isFalse(fs.existsSync(cachedSnapshotPath()));
        } else {
          assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), testCase.base);
        }
        if (testCase.remote === null) {
          assert.isFalse(fs.existsSync(fakeGistFilePath()));
        } else {
          assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), testCase.remote);
        }
      }
    });
  });

  it('refuses differing remote content when no cached base exists', () => {
    writeSnapshot('new value\n');
    seedFakeGist('old value\n');

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.include(result.stderr, 'Ballin changed neither the Gist nor the backup cache');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old value\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
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
    assert.equal(result.stdout, '✎ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
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
    assert.isFalse(fs.existsSync(fakeGistFilePath()));
    assert.deepEqual(gistUploads(), []);
  });

  it('reports a failure when a Gist upload fails', () => {
    writeSnapshot('export COLOR=blue\n');
    seedBackupCache('export COLOR=red\n');
    seedFakeGist('export COLOR=red\n');

    const result = runBackup({ ghUploadFail: true });

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'simulated gh api upload failure\n'
        + 'ballin backup: the Gist update failed or its outcome is unknown; '
        + 'backup caches were left unchanged\n'
        + 'ballin backup: rerun ballin backup to re-read and reconcile current remote state\n',
    );
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
    assert.equal(retriedResult.stdout, '✎ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('sends one PATCH containing only safely changed snapshots', () => {
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git value\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitignore_global'), 'stable ignore\n');
    seedBackupCache('old zsh value\n');
    seedCacheFile('gitconfig', 'old git value\n');
    seedCacheFile('gitignore_global', 'stable ignore\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.deepEqual(gistUploads(), [snapshotFileName, 'gitconfig']);
    assert.lengthOf(gistPatchCalls(), 1);
    assert.deepEqual(Object.keys(gistPayload().files), [snapshotFileName, 'gitconfig']);
    assert.deepEqual(gistPayload(), {
      files: {
        [snapshotFileName]: { content: 'new zsh value\n' },
        gitconfig: { content: 'new git value\n' },
      },
    });
  });

  it('refuses a sequential stale writer without overwriting the first writer', () => {
    writeSnapshot('Mac A value\n');
    seedBackupCache('shared base\n');

    const macAResult = runBackup();
    seedBackupCache('shared base\n', false);
    writeSnapshot('Mac B value\n');
    const macBResult = runBackup();

    assertBackupSucceeded(macAResult);
    assert.equal(macBResult.status, 1);
    assert.equal(macBResult.stdout, '');
    assert.include(macBResult.stderr, `ballin backup: conflict for ${snapshotFileName}`);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'Mac A value\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'shared base\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('reports every conflict before refusing the complete run', () => {
    writeSnapshot('local zsh\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'local git\n');
    seedBackupCache('base zsh\n', false);
    seedCacheFile('gitconfig', 'base git\n', false);
    seedFakeGist('remote zsh\n');
    seedFakeGistFile('gitconfig', 'remote git\n');

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `conflict for ${snapshotFileName}`);
    assert.include(result.stderr, 'conflict for gitconfig');
    assert.include(result.stderr, "'ballin backup read <file>'");
    assert.deepEqual(gistUploads(), []);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base zsh\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'base git\n');
  });

  it('preserves every cache entry when Gist metadata cannot be parsed', () => {
    writeSnapshot('new zsh\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git\n');
    seedBackupCache('old zsh\n');
    seedCacheFile('gitconfig', 'old git\n');

    const result = runBackup({ ghMetadataInvalid: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'unable to parse Gist metadata');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'old git\n');
    assert.deepEqual(gistUploads(), []);
  });

  ([
    { mode: 'files-array', message: 'GitHub returned invalid Gist metadata' },
    { mode: 'files-null', message: 'GitHub returned invalid Gist metadata' },
    { mode: 'truncated-string', message: 'GitHub returned an invalid Gist truncation marker' },
    { mode: 'file-null', message: `invalid remote metadata for ${snapshotFileName}` },
  ] as const).forEach(({ mode, message }) => {
    it(`fails closed for malformed ${mode} Gist metadata`, () => {
      writeSnapshot('new value\n');
      seedBackupCache('old value\n');

      const result = runBackup({ ghMetadataMode: mode });

      assert.equal(result.status, 1);
      assert.include(result.stderr, message);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old value\n');
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old value\n');
      assert.deepEqual(gistPatchCalls(), []);
    });
  });

  it('fails closed when the remote Gist file list is truncated', () => {
    writeSnapshot('local value\n');
    seedBackupCache('base value\n');

    const result = runBackup({ ghMetadataTruncated: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'remote Gist file list was truncated');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base value\n');
    assert.deepEqual(gistUploads(), []);
  });

  it('fails closed when a remote file has invalid truncation metadata', () => {
    writeSnapshot('local value\n');
    seedBackupCache('base value\n');

    const result = runBackup({ ghFileTruncationInvalid: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `invalid truncation metadata for remote snapshot ${snapshotFileName}`);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base value\n');
    assert.deepEqual(gistUploads(), []);
  });

  (['missing', 'invalid'] as const).forEach((sizeMode) => {
    it(`fails closed when a remote file has ${sizeMode} size metadata`, () => {
      writeSnapshot('local value\n');
      seedBackupCache('base value\n');
      seedFakeGist('base value\n');

      const result = runBackup({ ghFileSizeMode: sizeMode });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, `missing or invalid size metadata for remote snapshot ${snapshotFileName}`);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base value\n');
      assert.deepEqual(gistUploads(), []);
    });
  });

  it('fails closed when a raw remote read does not match its declared byte size', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedBackupCache(largeSnapshot);
    seedFakeGist(largeSnapshot);

    const result = runBackup({ ghFileSizeMode: 'mismatch' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `remote snapshot ${snapshotFileName} was incomplete or changed while reading`);
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
  });

  it('preserves caches when a truncated remote file raw read fails', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedBackupCache(largeSnapshot);

    const result = runBackup({ ghRawReadFailures: [snapshotFileName] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `failed to read remote snapshot ${snapshotFileName}`);
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(gistReads(), [snapshotFileName]);
  });

  it('preserves caches when a truncated remote file raw read is interrupted', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedBackupCache(largeSnapshot);

    const result = runBackup({ ghRawReadSignals: [snapshotFileName] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `failed to read remote snapshot ${snapshotFileName}`);
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(gistReads(), [snapshotFileName]);
  });

  it('leaves caches stale after an ambiguous PATCH and reconciles on retry', () => {
    writeSnapshot('new value\n');
    seedBackupCache('old value\n');

    const ambiguousResult = runBackup({ ghUploadAmbiguous: true });

    assert.equal(ambiguousResult.status, 1);
    assert.equal(ambiguousResult.stdout, '');
    assert.include(ambiguousResult.stderr, 'Gist update failed or its outcome is unknown');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new value\n');

    const retryResult = runBackup();

    assertBackupSucceeded(retryResult);
    assert.equal(retryResult.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new value\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('recovers from a partial multi-file cache promotion without another PATCH', () => {
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git value\n');
    fs.mkdirSync(cachedFilePath('gitconfig'), { recursive: true });

    const failedPromotion = runBackup();

    assert.equal(failedPromotion.status, 1);
    assert.equal(failedPromotion.stdout, '');
    assert.include(failedPromotion.stderr, 'failed to promote cache for gitconfig');
    assert.include(failedPromotion.stderr, 'Gist outcome is known');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'gitconfig'), 'utf8'), 'new git value\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.isTrue(fs.statSync(cachedFilePath('gitconfig')).isDirectory());

    fs.rmSync(cachedFilePath('gitconfig'), { recursive: true });
    const recoveredResult = runBackup();

    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, '✔ zshrc\n✔ gitconfig\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'new git value\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('routes metadata and PATCH requests through the configured Enterprise hostname', () => {
    const enterpriseHost = 'github.enterprise.test';
    writeBackupConfig('test-gist-id', enterpriseHost);
    writeSnapshot('enterprise value\n');

    const result = runBackup({ ghExpectedHost: enterpriseHost });

    assertBackupSucceeded(result);
    assert.lengthOf(gistPatchCalls(), 1);
    gistRequests().forEach((call: string) => {
      assert.include(call, `--hostname ${enterpriseHost}`);
    });
  });

  it('streams large snapshot output without the default spawn buffer limit', () => {
    const largeSnapshot = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
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
    assert.include(result.stdout, '✚ vs_extensions\n');
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

  it('uses the new-file marker when empty becomes non-empty', () => {
    writeSnapshot('restored\n');
    seedBackupCache('empty\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
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
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'cat: simulated failure reading .zshrc\n'
        + 'ballin backup: failed to snapshot zshrc.sh\n',
    );
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old zsh value\n');
    assert.isFalse(fs.existsSync(path.join(backupCacheDir, 'gitconfig')));
    assert.isFalse(fs.existsSync(path.join(fakeGistDir, 'gitconfig')));
    assert.deepEqual(gistUploads(), []);
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
    assert.deepEqual(gistReads(), []);
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
    assert.equal(recoveredResult.stdout, '✎ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'recovered\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'recovered\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
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
    assert.isFalse(fs.existsSync(backupCacheDir));
    assert.deepEqual(gistRequests(), []);
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });
});
