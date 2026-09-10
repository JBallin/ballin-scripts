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
const expectedFileSuggestions = `
  ballin_config
  bash_completions
  bash_profile.sh
  bashrc.sh
  Brewfile
  brew_cask
  brew_leaves
  brew_list
  brew_services
  gitconfig
  gitignore_global
  mas
  nanorc
  npm_global
  nvmrc
  pipx
  profile.sh
  pyenv_versions
  uv_tools
  vimrc
  vs_extensions
  vs_keybindings
  vs_settings
  vsI_extensions
  vsI_keybindings
  vsI_settings
  zprofile.sh
  zshrc.sh`;
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
  ghActiveFlagUnsupported?: boolean;
  ghAuthFail?: boolean;
  ghInactiveAccountExpired?: boolean;
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
  umask?: '000' | '022' | '077';
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
    config.backup = { ...config.backup, id, host };
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
if [ "$1:$2:$3:$4" = "api:--hostname:$FAKE_GH_EXPECTED_HOST:user" ] && [ "$#" -eq 4 ]; then
  if [ "$FAKE_GH_AUTH_FAIL" = 'true' ]; then
    printf '%s\n' 'simulated gh auth failure' >&2
    exit 4
  fi
  if [ "$FAKE_GH_REMOVE_AFTER_AUTH" = 'true' ]; then rm "$0"; fi
  exit 0
fi
if [ "$1:$2" = 'auth:status' ]; then
  if [ "$3" = '--active' ] && [ "$FAKE_GH_ACTIVE_FLAG_UNSUPPORTED" = 'true' ]; then
    printf '%s\n' 'unknown flag: --active' >&2
    exit 1
  fi
  if [ "$*" = "auth status --hostname $FAKE_GH_EXPECTED_HOST" ] && [ "$FAKE_GH_INACTIVE_ACCOUNT_EXPIRED" = 'true' ]; then
    printf '%s\n' 'simulated expired inactive account' >&2
    exit 4
  fi
  if [ "$*" != "auth status --active --hostname $FAKE_GH_EXPECTED_HOST" ]; then
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
    ghActiveFlagUnsupported = false,
    ghInactiveAccountExpired = false,
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
    umask,
  }: RunBackupOptions = {}) => spawnSync(
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
      FAKE_GH_ACTIVE_FLAG_UNSUPPORTED: ghActiveFlagUnsupported ? 'true' : 'false',
      FAKE_GH_INACTIVE_ACCOUNT_EXPIRED: ghInactiveAccountExpired ? 'true' : 'false',
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
  const installChmodFailureLauncher = (failurePath: string, staged = false) => {
    const launcherName = 'backup-chmod-failure.cjs';
    writeTestExecutable(launcherName, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const originalChmod = fs.chmodSync;
fs.chmodSync = (entryPath, mode) => {
  const matches = ${staged}
    ? path.dirname(path.dirname(entryPath)) === ${JSON.stringify(backupCacheDir)}
      && path.basename(path.dirname(entryPath)).startsWith('.ballin-backup-cache-')
      && path.basename(entryPath) === ${JSON.stringify(failurePath)}
    : entryPath === ${JSON.stringify(failurePath)};
  if (matches) throw new Error('simulated cache chmod failure');
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

  it('uses the active account on gh versions without auth status --active before opening', () => {
    const result = runBackup({
      args: ['open'],
      ghActiveFlagUnsupported: true,
      ghInactiveAccountExpired: true,
    });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(openCalls(), ['gist view test-gist-id --web']);
    assert.deepEqual(ghCalls(), [
      'api --hostname example.test user',
      'gist view test-gist-id --web',
    ]);
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
if [ "$*" = 'api --hostname example.test user' ]; then exit 0; fi
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

    const result = runBackup({ args: ['setup', 'extra', 'another'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup setup: expected at most one repository name\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistRequests(), []);
  });

  it('rejects malformed config before prompting or using GitHub during setup', () => {
    writeInvalidConfig();

    const result = runBackup({ args: ['setup'] });

    assert.equal(result.status, 1);
    assert.notInclude(result.stdout, 'Set up optional Gist backups now?');
    assert.include(result.stderr, 'ballin backup setup: unable to inspect config');
    assert.deepEqual(ghCalls(), []);
  });

  it('rejects malformed backup IDs during standalone setup without mutation or GitHub work', () => {
    [42, ['unexpected-id'], { value: 'unexpected-id' }].forEach((id) => {
      writeCompleteBackupConfig(id, 'example.test');
      seedBackupCache('preserve invalid destination cache\n', false);
      const previousConfig = fs.readFileSync(configPath, 'utf8');

      const result = runBackup({ args: ['setup'], input: 'y\n' });

      assert.equal(result.status, 1);
      assert.include(result.stdout, 'Repair the backup destination configuration');
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
      'api --hostname github.com user',
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
      'api --hostname github.enterprise.test user',
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
        'api --hostname github.enterprise.test user',
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
    assert.equal(config.update.backup, 'false');
    assert.deepEqual(ghCalls(), ['api --hostname github.enterprise.test user']);
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
    assert.deepEqual(ghCalls(), ['api --hostname github.enterprise.test user']);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'preserve configured cache\n');
  });

  ['update', 'analytics', 'backup'].forEach((section) => {
    it(`rejects a malformed local ${section} section before standalone setup refresh or side effects`, () => {
      const original = JSON.stringify({ [section]: 'LOCAL_DUMMY_SECRET' });
      fs.writeFileSync(configPath, original);
      seedBackupCache('unchanged base\n');

      const result = runBackup({ args: ['setup'], input: 'y\n' });

      assert.equal(result.status, 1);
      assert.include(result.stdout, section);
      assert.notInclude(result.stdout + result.stderr, 'LOCAL_DUMMY_SECRET');
      assert.equal(fs.readFileSync(configPath, 'utf8'), original);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'unchanged base\n');
      assert.deepEqual(ghCalls(), []);
    });
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

  it('uses the active account for the configured host before reading a named Gist file', () => {
    seedFakeGistFile('vimrc', 'set number\n');

    const result = runBackup({
      args: ['read', 'vimrc'],
      ghActiveFlagUnsupported: true,
      ghInactiveAccountExpired: true,
    });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
    assert.deepEqual(gistReads(), ['vimrc']);
    assert.deepEqual(ghCalls(), [
      'api --hostname example.test user',
      'gist view test-gist-id --files',
      'gist view test-gist-id --raw --filename vimrc',
    ]);
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
    assert.equal(result.stdout, `\nOptions: ${expectedFileSuggestions}\n`);
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
    assert.equal(
      result.stdout,
      `Error: 'read' needs a filename.\n\nOptions: ${expectedFileSuggestions}\n`,
    );
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

  for (const prefix of ['ballin-backup-input-', 'ballin-backup-remote-']) {
    it(`fails after publication and cache promotion when ${prefix} cleanup fails`, () => {
      writeSnapshot('new snapshot\n');
      seedBackupCache('old snapshot\n');
      const commandPath = installCleanupFailureLauncher([prefix]);

      const result = runBackup({ commandPath });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
      assert.include(result.stderr, 'completed remote and cache effects are retained');
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new snapshot\n');
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.lengthOf(gistPatchCalls(), 1);
      assertOwnerOnlyCache();
      const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
      assert.lengthOf(attempts, 1);
      assert.isTrue(fs.existsSync(path.join(attempts[0], 'output')));
      assert.deepEqual(fs.readdirSync(scratchDir), [path.basename(attempts[0])]);

      const next = runBackup();
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.stdout, '✔ zshrc\n');
      assert.lengthOf(gistPatchCalls(), 1);
    });
  }

  it('reports both cleanup failures alongside a Gist conflict and attempts each removal once', () => {
    writeSnapshot('local change\n');
    seedBackupCache('base\n');
    seedFakeGist('remote change\n');
    const commandPath = installCleanupFailureLauncher(['ballin-backup-input-', 'ballin-backup-remote-']);
    const result = runBackup({ commandPath });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'conflict for zshrc.sh');
    assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'remote change\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'base\n');
    assert.deepEqual(gistPatchCalls(), []);
    const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
    assert.lengthOf(attempts, 2);
    assert.equal(new Set(attempts).size, 2);
  });

  it('preserves collector failure and later captures when failed-input and staged cleanup fail', () => {
    writeSnapshot('failed input\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'later capture\n');
    const commandPath = installCleanupFailureLauncher(['ballin-backup-input-']);
    const result = runBackup({ commandPath, failedPaths: ['.zshrc'], emitUnderlyingStderr: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'cat: simulated failure reading .zshrc');
    assert.include(result.stderr, 'failed to snapshot zshrc.sh');
    assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
    assert.deepEqual(gistRequests(), []);
    assert.isFalse(fs.existsSync(backupCacheDir));
    const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
    assert.lengthOf(attempts, 2);
    assert.equal(new Set(attempts).size, 2);
    assert.equal(fs.readFileSync(path.join(attempts[1], 'output'), 'utf8'), 'later capture\n');
  });

  it('preserves remote-read failure and cleans staged files without retrying failed remote cleanup', () => {
    writeSnapshot('local capture\n');
    seedBackupCache('old snapshot\n');
    const commandPath = installCleanupFailureLauncher(['ballin-backup-remote-']);
    const result = runBackup({ commandPath, ghFileSizeMode: 'mismatch' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'failed to read remote snapshot zshrc.sh');
    assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
    assert.deepEqual(gistPatchCalls(), []);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old snapshot\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old snapshot\n');
    const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
    assert.lengthOf(attempts, 1);
    assert.deepEqual(fs.readdirSync(scratchDir), [path.basename(attempts[0])]);
  });

  for (const prefix of ['ballin-backup-gist-metadata-', 'ballin-backup-stderr-', 'ballin-backup-payload-']) {
    it(`reports ${prefix} cleanup failure without success markers or cache promotion`, () => {
      writeSnapshot('new snapshot\n');
      seedBackupCache('old snapshot\n');
      const commandPath = installCleanupFailureLauncher([prefix]);
      const result = runBackup({ commandPath });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'private temporary-file cleanup is incomplete');
      const published = prefix === 'ballin-backup-payload-';
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), published ? 'new snapshot\n' : 'old snapshot\n');
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old snapshot\n');
      assert.lengthOf(gistPatchCalls(), published ? 1 : 0);
      const attempts = readLogLines(path.join(testHomeDir, 'cleanup-attempts.log'));
      assert.lengthOf(attempts, 1);
      assert.deepEqual(fs.readdirSync(scratchDir), [path.basename(attempts[0])]);
    });
  }

  it('reports incomplete cache staging cleanup while retaining completed Gist and cache updates', () => {
    writeSnapshot('new snapshot\n');
    seedBackupCache('old snapshot\n');
    const result = runBackup({ commandPath: installCleanupFailureLauncher(['.ballin-backup-cache-']) });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'unable to finish private cache staging cleanup');
    assert.include(result.stderr, 'Gist outcome is known');
    assert.include(result.stderr, 'cleanup is incomplete');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new snapshot\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.lengthOf(gistPatchCalls(), 1);
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
    makeCachePermissive();
    const result = runBackup({ ghInitialReadSignal: true, umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ballin backup: failed to read current Gist state\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'cached base\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'cached base\n');
    assertOwnerOnlyCache();
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
    writeSnapshot('new snapshot\n');
    seedBackupCache('cached base\n');
    makeCachePermissive();
    const result = runBackup({ ghAuthFail: true, failedPaths: ['.zshrc'], umask: '000' });

    assert.equal(result.status, 4);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'simulated gh auth failure\n'
        + 'ballin backup: GitHub CLI authentication is required for example.test\n'
        + "ballin backup: run 'gh auth login --hostname example.test'\n",
    );
    assertOwnerOnlyCache();
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'cached base\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'cached base\n');
    assert.deepEqual(ghCalls(), ['api --hostname example.test user']);
    assert.deepEqual(gistRequests(), []);
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
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'private snapshot\n');
      assert.deepEqual(fs.readdirSync(backupCacheDir), [snapshotFileName]);
      assert.lengthOf(gistPatchCalls(), 1);
    });
  });

  it('repairs every existing cache entry on an unchanged run without a PATCH', () => {
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
    assert.equal(result.stdout, '✔ zshrc\n');
    assertOwnerOnlyCache();
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'shared snapshot\n');
    assert.equal(fs.readFileSync(cachedFilePath('inactive-snapshot'), 'utf8'), 'old inactive snapshot\n');
    assert.equal(fs.readFileSync(leftoverFile, 'utf8'), 'leftover contents\n');
    assert.deepEqual(gistPatchCalls(), []);
  });

  it('retains remote and cached snapshots whose source tool is unavailable', () => {
    seedCacheFile('npm_global', 'retained npm inventory\n');

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(cachedFilePath('npm_global'), 'utf8'), 'retained npm inventory\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'npm_global'), 'utf8'), 'retained npm inventory\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('retains remote and cached snapshots whose source discovery fails', () => {
    seedBackupCache('retained shell config\n');
    fs.symlinkSync('.zshrc', snapshotPath());

    const result = runBackup();

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'retained shell config\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'retained shell config\n');
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
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
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new snapshot\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  (['directory', 'existing file'] as const).forEach((failure) => {
    it(`stops before authentication and collection when securing the ${failure} fails`, () => {
      writeSnapshot('new snapshot\n');
      seedBackupCache('old snapshot\n');
      makeCachePermissive();
      const failurePath = failure === 'directory' ? backupCacheDir : cachedSnapshotPath();
      const commandPath = installChmodFailureLauncher(failurePath);

      const result = runBackup({ commandPath, failedPaths: ['.zshrc'], umask: '000' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'unable to secure backup cache permissions');
      assert.include(result.stderr, 'simulated cache chmod failure');
      assert.notInclude(result.stderr, 'failed to snapshot');
      assert.equal(fs.statSync(backupCacheDir).mode & 0o777, failure === 'directory' ? 0o777 : 0o700);
      assert.equal(fs.statSync(cachedSnapshotPath()).mode & 0o777, 0o666);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old snapshot\n');
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old snapshot\n');
      assert.deepEqual(ghCalls(), []);
      assert.deepEqual(fs.readdirSync(scratchDir), []);

      const recoveredResult = runBackup({ umask: '000' });

      assertBackupSucceeded(recoveredResult);
      assertOwnerOnlyCache();
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
      assert.lengthOf(gistPatchCalls(), 1);
    });
  });

  it('cleans all staged copies after chmod failure and reconciles on retry without another PATCH', () => {
    writeSnapshot('new zsh snapshot\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git snapshot\n');
    seedBackupCache('old zsh snapshot\n');
    seedCacheFile('gitconfig', 'old git snapshot\n');
    makeCachePermissive();
    const commandPath = installChmodFailureLauncher('gitconfig', true);

    const result = runBackup({ commandPath, umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'failed to stage cache update for gitconfig');
    assert.include(result.stderr, 'simulated cache chmod failure');
    assert.include(result.stderr, 'Gist outcome is known');
    assertOwnerOnlyCache();
    assert.deepEqual(fs.readdirSync(backupCacheDir).sort(), ['gitconfig', snapshotFileName]);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh snapshot\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'old git snapshot\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new zsh snapshot\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'gitconfig'), 'utf8'), 'new git snapshot\n');

    const recoveredResult = runBackup({ umask: '000' });

    assertBackupSucceeded(recoveredResult);
    assertOwnerOnlyCache();
    assert.equal(recoveredResult.stdout, '✔ zshrc\n✔ gitconfig\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh snapshot\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'new git snapshot\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('creates a private cache even when its promotion-time directory chmod fails', () => {
    writeSnapshot('new snapshot\n');
    const commandPath = installChmodFailureLauncher(backupCacheDir);

    const result = runBackup({ commandPath, umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'failed to prepare backup cache updates');
    assert.include(result.stderr, 'simulated cache chmod failure');
    assert.include(result.stderr, 'Gist outcome is known');
    assertOwnerOnlyCache();
    assert.deepEqual(fs.readdirSync(backupCacheDir), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new snapshot\n');

    const recoveredResult = runBackup({ umask: '000' });

    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, '✔ zshrc\n');
    assertOwnerOnlyCache();
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new snapshot\n');
    assert.lengthOf(gistPatchCalls(), 1);
  });

  (['cache root', 'cache entry'] as const).forEach((location) => {
    it(`rejects a symbolic link at the ${location} without changing its target`, () => {
      const targetDir = path.join(testHomeDir, 'outside-cache');
      const targetFile = path.join(targetDir, 'private-file');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(targetFile, 'external contents\n');
      fs.chmodSync(targetDir, 0o755);
      fs.chmodSync(targetFile, 0o644);
      if (location === 'cache root') {
        fs.symlinkSync(targetDir, backupCacheDir);
      } else {
        fs.mkdirSync(backupCacheDir);
        fs.chmodSync(backupCacheDir, 0o777);
        fs.symlinkSync(targetFile, cachedSnapshotPath());
      }
      writeSnapshot('new snapshot\n');

      const result = runBackup({ failedPaths: ['.zshrc'], umask: '000' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'unable to secure backup cache permissions');
      assert.notInclude(result.stderr, 'failed to snapshot');
      assert.equal(fs.statSync(targetDir).mode & 0o777, 0o755);
      assert.equal(fs.statSync(targetFile).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), 'external contents\n');
      assert.isTrue(fs.lstatSync(location === 'cache root' ? backupCacheDir : cachedSnapshotPath()).isSymbolicLink());
      assert.deepEqual(ghCalls(), []);
      assert.deepEqual(fs.readdirSync(scratchDir), []);
    });
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

    const result = runBackup({ umask: '000' });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export EDITOR=vim\n');
    assertOwnerOnlyCache();
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('captures only portable config leaves while retaining current Gist raw-source behavior', () => {
    const source = {
      update: { cleanup: false, npm: true },
      analytics: { enabled: 'false' },
      backup: { id: 'PRIVATE_DESTINATION', host: 'private.test', includeRaw: false, includeDetailed: false },
      custom: { token: 'CONFIG_DUMMY_SECRET' },
    };
    fs.writeFileSync(path.join(testHomeDir, '.ballin-scripts', 'ballin.config.json'), JSON.stringify(source));
    const rawTarget = path.join(testHomeDir, 'selected-dotfile');
    fs.writeFileSync(rawTarget, 'export DEMO_TOKEN=RAW_DUMMY_SECRET');
    fs.symlinkSync(rawTarget, snapshotPath());
    fs.writeFileSync(path.join(testHomeDir, '.nvmrc'), 'arbitrary DUMMY_TOKEN=value');
    const pipxContent = '{"venvs":{"demo":{"metadata":{"main_package":{"package_or_url":"https://DUMMY_TOKEN@private.test/demo","pip_args":["--index-url","https://DUMMY_TOKEN@private.test"]}}}}}\n';
    writeTestExecutable('pipx', `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(pipxContent)});
`);

    const result = runBackup();

    assertBackupSucceeded(result);
    const remoteConfig = fs.readFileSync(path.join(fakeGistDir, 'ballin_config'), 'utf8');
    assert.deepEqual(JSON.parse(remoteConfig), {
      update: { cleanup: 'false', npm: 'true' },
      analytics: { enabled: 'false' },
    });
    assert.notInclude(remoteConfig, 'PRIVATE_DESTINATION');
    assert.notInclude(remoteConfig, 'CONFIG_DUMMY_SECRET');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export DEMO_TOKEN=RAW_DUMMY_SECRET\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'nvmrc'), 'utf8'), 'arbitrary DUMMY_TOKEN=value\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'pipx'), 'utf8'), pipxContent);
    assert.isTrue(fs.lstatSync(snapshotPath()).isSymbolicLink());
    assert.lengthOf(gistPatchCalls(), 1);

    const second = runBackup();
    assertBackupSucceeded(second);
    assert.lengthOf(gistPatchCalls(), 1, 'unchanged projected content must remain a true no-op');
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
      assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), `${content}\n`);
      assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), `${content}\n`);
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), content);
      assert.equal(fs.realpathSync(snapshotPath()), fs.realpathSync(sourcePath));
      assert.isTrue(fs.lstatSync(snapshotPath()).isSymbolicLink());
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('aborts all staged captures before remote reads when portable projection fails', () => {
    const original = 'unchanged raw base\n';
    seedBackupCache(original);
    writeSnapshot('new raw value\n');
    fs.writeFileSync(path.join(testHomeDir, '.ballin-scripts', 'ballin.config.json'), JSON.stringify({
      update: { npm: 'INVALID_DUMMY_SECRET' },
    }));

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'update.npm');
    assert.include(result.stderr, 'failed to snapshot ballin_config');
    assert.notInclude(result.stdout + result.stderr, 'INVALID_DUMMY_SECRET');
    assert.deepEqual(gistRequests(), []);
    assert.deepEqual(gistPatchCalls(), []);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), original);
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), original);
  });

  it('requires normal conflict reconciliation for a legacy full-config snapshot without a trusted base', () => {
    const legacy = JSON.stringify({
      update: { cleanup: 'false' }, backup: { id: 'old-id' }, custom: 'REMOTE_DUMMY_SECRET',
    }) + '\n';
    fs.writeFileSync(path.join(testHomeDir, '.ballin-scripts', 'ballin.config.json'), legacy);
    seedFakeGistFile('ballin_config', legacy);

    const result = runBackup();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'conflict for ballin_config');
    assert.deepEqual(gistPatchCalls(), []);
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'ballin_config'), 'utf8'), legacy);
    assert.isFalse(fs.existsSync(cachedFilePath('ballin_config')));
  });

  it('retains excluded sensitive remote/cache contents when the shared default selection feeds the writer', () => {
    // Substitute source observation in the fixture, keeping the complete real
    // staging/reconciliation writer without adding a production policy flag.
    const wrapper = path.join(testHomeDir, 'policy-backup');
    fs.writeFileSync(wrapper, `#!/usr/bin/env node
const snapshots = require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup_snapshots.ts'))});
const observe = snapshots.observeSnapshotSources;
snapshots.observeSnapshotSources = (context) => observe(context);
require(${JSON.stringify(path.join(repoRoot, 'commands', 'backup.ts'))}).runBackupCommand(process.argv.slice(3));
`, { mode: 0o755 });
    seedBackupCache('retained raw base\n');
    seedCacheFile('pipx', 'retained sensitive install metadata\n');
    writeTestExecutable('pipx', '#!/usr/bin/env bash\nexit 23\n');
    writeSnapshot('excluded raw change\n');

    const result = runBackup({ commandPath: wrapper, failedPaths: ['.zshrc'] });

    assertBackupSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(gistPatchCalls(), []);
    assert.deepEqual(gistReads(), []);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'retained raw base\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'retained raw base\n');
    assert.equal(fs.readFileSync(cachedFilePath('pipx'), 'utf8'), 'retained sensitive install metadata\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'pipx'), 'utf8'), 'retained sensitive install metadata\n');
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
        makeCachePermissive();
      }
      if (testCase.remote !== null) {
        seedFakeGist(testCase.remote);
      }

      const result = runBackup({ umask: '000' });

      assert.equal(result.status, testCase.expectedStatus);
      assert.equal(result.stdout, testCase.expectedOutput);
      assert.deepEqual(gistUploads(), testCase.uploads);
      if (testCase.base !== null || testCase.expectedStatus === 0) {
        assertOwnerOnlyCache();
      }
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
    assert.include(result.stderr, 'Ballin changed neither the Gist nor the backup cache contents');
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
    makeCachePermissive();

    const result = runBackup({ ghUploadFail: true, umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'simulated gh api upload failure\n'
        + 'ballin backup: the Gist update failed or its outcome is unknown; '
        + 'backup cache contents were left unchanged\n'
        + 'ballin backup: rerun ballin backup to re-read and reconcile current remote state\n',
    );
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=red\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=red\n');
    assertOwnerOnlyCache();
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
    makeCachePermissive();

    const result = runBackup({ ghMetadataInvalid: true, umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'unable to parse Gist metadata');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'old git\n');
    assertOwnerOnlyCache();
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
    makeCachePermissive();

    const result = runBackup({ ghRawReadFailures: [snapshotFileName], umask: '000' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, `failed to read remote snapshot ${snapshotFileName}`);
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assertOwnerOnlyCache();
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
    makeCachePermissive();

    const ambiguousResult = runBackup({ ghUploadAmbiguous: true, umask: '000' });

    assert.equal(ambiguousResult.status, 1);
    assert.equal(ambiguousResult.stdout, '');
    assert.include(ambiguousResult.stderr, 'Gist update failed or its outcome is unknown');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new value\n');
    assertOwnerOnlyCache();

    const retryResult = runBackup({ umask: '000' });

    assertBackupSucceeded(retryResult);
    assert.equal(retryResult.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new value\n');
    assertOwnerOnlyCache();
    assert.lengthOf(gistPatchCalls(), 1);
  });

  it('recovers from a partial multi-file cache promotion without another PATCH', () => {
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(path.join(testHomeDir, '.gitconfig'), 'new git value\n');
    fs.mkdirSync(cachedFilePath('gitconfig'), { recursive: true });
    makeCachePermissive();

    const failedPromotion = runBackup({ umask: '000' });

    assert.equal(failedPromotion.status, 1);
    assert.equal(failedPromotion.stdout, '');
    assert.include(failedPromotion.stderr, 'failed to promote cache for gitconfig');
    assert.include(failedPromotion.stderr, 'Gist outcome is known');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(path.join(fakeGistDir, 'gitconfig'), 'utf8'), 'new git value\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.isTrue(fs.statSync(cachedFilePath('gitconfig')).isDirectory());
    assertOwnerOnlyCache();
    assert.deepEqual(fs.readdirSync(backupCacheDir).sort(), ['gitconfig', snapshotFileName]);
    assert.deepEqual(fs.readdirSync(scratchDir), []);

    fs.rmSync(cachedFilePath('gitconfig'), { recursive: true });
    const recoveredResult = runBackup({ umask: '000' });

    assertBackupSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, '✔ zshrc\n✔ gitconfig\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new zsh value\n');
    assert.equal(fs.readFileSync(cachedFilePath('gitconfig'), 'utf8'), 'new git value\n');
    assertOwnerOnlyCache();
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
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old zsh value\n');
    assertOwnerOnlyCache();
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
