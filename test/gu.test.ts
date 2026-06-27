const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guPath = path.join(__dirname, '..', 'bin', 'gu');
const snapshotFileName = 'zshrc.sh';
// Expose only the basic commands gu needs; package managers remain unavailable.
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

type RunGuOptions = {
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
  ghUploadFail?: boolean;
  commandPath?: string;
};

describe('gu', () => {
  let testHomeDir: string;
  let testBinDir: string;
  let guCacheDir: string;
  let fakeGistDir: string;
  let gistReadLogPath: string;
  let scratchDir: string;
  let gistUploadLogPath: string;
  let brewLogPath: string;
  let openLogPath: string;
  let ballinLogPath: string;
  let realCatPath: string;

  const linkRequiredCommand = (command: string) => {
    const commandPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, command))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${command} is required to run the gu test harness`);
    fs.symlinkSync(commandPath, path.join(testBinDir, command));
  };

  const writeTestExecutable = (name: string, contents: string) => {
    fs.writeFileSync(path.join(testBinDir, name), contents, { mode: 0o755 });
  };

  const installFakeBallinConfigCommand = () => {
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
if [ "$1" != 'get' ]; then
  printf '%s\\n' 'Unexpected ballin_config action' >&2
  exit 2
elif [ "$2" = 'gu.id' ]; then
  printf '%s\\n' 'test-gist-id'
elif [ "$2" = 'gu.host' ]; then
  printf '%s\\n' 'example.test'
else
  printf '%s\\n' 'Unexpected ballin_config call' >&2
  exit 2
fi
`);
  };

  const installFakeGhCommand = () => {
    // Store the fake remote Gist as ordinary files inside the temporary test home.
    writeTestExecutable('gh', `#!/usr/bin/env bash
if [ "$GH_HOST" != 'example.test' ] && [ "$1:$2" != 'auth:status' ]; then
  printf '%s\\n' 'Unexpected GH_HOST' >&2
  exit 2
fi
if [ "$1:$2" = 'auth:status' ]; then
  if [ "$*" != 'auth status --active --hostname example.test' ]; then
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

  const installFailingBallinConfigCommand = () => {
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
printf 'ballin_config failed for %s\\n' "$2" >&2
exit 42
`);
  };

  const installDefaultIdBallinConfigCommand = () => {
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
if [ "$1" != 'get' ]; then
  printf '%s\\n' 'Unexpected ballin_config action' >&2
  exit 2
elif [ "$2" = 'gu.id' ]; then
  printf '%s\\n' 'null'
elif [ "$2" = 'gu.host' ]; then
  printf '%s\\n' 'example.test'
else
  printf '%s\\n' 'Unexpected ballin_config call' >&2
  exit 2
fi
`);
  };

  const removeBallinConfigCommand = () => {
    fs.rmSync(path.join(testBinDir, 'ballin_config'));
  };

  const makeBallinConfigCommandPermissionDenied = () => {
    fs.writeFileSync(path.join(testBinDir, 'ballin_config'), 'not executable\n', { mode: 0o644 });
    fs.chmodSync(path.join(testBinDir, 'ballin_config'), 0o644);
  };

  const removeGhCommand = () => {
    fs.rmSync(path.join(testBinDir, 'gh'));
  };

  const makeGhCommandPermissionDenied = () => {
    fs.writeFileSync(path.join(testBinDir, 'gh'), 'not executable\n', { mode: 0o644 });
    fs.chmodSync(path.join(testBinDir, 'gh'), 0o644);
  };

  const installFakeBallinCommand = () => {
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_BALLIN_LOG"
printf '%s\\n' 'fake ballin help'
`);
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
    testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-gu-'));
    testBinDir = path.join(testHomeDir, 'bin');
    guCacheDir = path.join(testHomeDir, '.ballin-scripts', '.gu-cache');
    fakeGistDir = path.join(testHomeDir, 'fake-gist');
    gistReadLogPath = path.join(testHomeDir, 'fake-gist-reads.log');
    scratchDir = path.join(testHomeDir, 'tmp');
    gistUploadLogPath = path.join(testHomeDir, 'fake-gist-uploads.log');
    brewLogPath = path.join(testHomeDir, 'fake-brew.log');
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
    installFakeBallinConfigCommand();
    installFakeGhCommand();
    installFakeOpenCommand();
    installFakeBallinCommand();
  });

  afterEach(() => {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  });

  // Pass a complete child environment so real tools and credentials are not inherited.
  const runGu = ({
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
    ghUploadFail = false,
    commandPath = guPath,
  }: RunGuOptions = {}) => spawnSync(commandPath, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      HOME: testHomeDir,
      PATH: testBinDir,
      TMPDIR: scratchDir,
      ...(completionDir === undefined ? {} : {
        BALLIN_GU_BASH_COMPLETION_DIR: completionDir,
      }),
      FAKE_GIST_STORAGE_DIR: fakeGistDir,
      FAKE_GIST_READ_LOG: gistReadLogPath,
      FAKE_GIST_UPLOAD_LOG: gistUploadLogPath,
      FAKE_GH_WEB_LOG: openLogPath,
      FAKE_GH_AUTH_FAIL: ghAuthFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_FAIL: ghInitialReadFail ? 'true' : 'false',
      FAKE_GH_INITIAL_READ_SIGNAL: ghInitialReadSignal ? 'true' : 'false',
      FAKE_GH_UPLOAD_FAIL: ghUploadFail ? 'true' : 'false',
      FAKE_BREW_LOG: brewLogPath,
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
  const cachedSnapshotPath = () => path.join(guCacheDir, snapshotFileName);
  const fakeGistFilePath = () => path.join(fakeGistDir, snapshotFileName);
  const writeSnapshot = (content: string) => fs.writeFileSync(snapshotPath(), content);
  const seedGuCache = (content: string) => {
    fs.mkdirSync(guCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), content);
  };
  const seedFakeGist = (content: string) => fs.writeFileSync(fakeGistFilePath(), content);
  const seedFakeGistFile = (fileName: string, content: string) => {
    fs.writeFileSync(path.join(fakeGistDir, fileName), content);
  };
  const assertGuSucceeded = (result: StringSpawnResult) => {
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
    const result = runGu({ args: ['open'] });

    assertGuSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(openCalls(), ['gist view test-gist-id --web']);
  });

  it('opens the configured Gist without requiring a readable Gist', () => {
    const result = runGu({ args: ['open'], ghInitialReadFail: true });

    assertGuSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(openCalls(), ['gist view test-gist-id --web']);
    assert.deepEqual(gistReads(), []);
  });

  it('fails open when extra arguments are provided', () => {
    const result = runGu({ args: ['open', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gu open: expected no arguments\n');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('fails open when Gist config cannot be read', () => {
    installFailingBallinConfigCommand();

    const result = runGu({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'ballin_config failed for gu.id\n'
        + 'ballin_config failed for gu.host\n'
        + 'gu: missing config value gu.id\n'
        + 'gu: missing config value gu.host\n',
    );
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('treats a default null Gist ID as missing when opening', () => {
    installDefaultIdBallinConfigCommand();

    const result = runGu({ args: ['open'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gu: missing config value gu.id\n');
    assert.deepEqual(openCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('remains executable through the installed symlink model', () => {
    const linkPath = path.join(testBinDir, 'gu-link');
    fs.symlinkSync(guPath, linkPath);
    seedFakeGistFile('vimrc', 'set number\n');

    const result = runGu({ args: ['read', 'vimrc'], commandPath: linkPath });

    assertGuSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
  });

  it('uses a shell-style signal exit status for open', () => {
    writeTestExecutable('gh', `#!/usr/bin/env bash
if [ "$1:$2" = 'auth:status' ]; then exit 0; fi
if [ "$*" = 'gist view test-gist-id --web' ]; then kill -TERM "$$"; fi
exit 2
`);

    const result = runGu({ args: ['open'] });

    assert.equal(result.status, 143);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('reports missing gh before opening', () => {
    removeGhCommand();

    const result = runGu({ args: ['open'] });

    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: command not found\n');
  });

  it('reports permission-denied gh before opening', () => {
    makeGhCommandPermissionDenied();

    const result = runGu({ args: ['open'] });

    assert.equal(result.status, 126);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: Permission denied\n');
  });

  it('prints help through the ballin command', () => {
    const result = runGu({ args: ['help'] });

    assertGuSucceeded(result);
    assert.equal(result.stdout, 'fake ballin help\n');
    assert.deepEqual(ballinCalls(), ['']);
  });

  it('prints help without requiring a readable Gist', () => {
    const result = runGu({ args: ['help'], ghInitialReadFail: true });

    assertGuSucceeded(result);
    assert.equal(result.stdout, 'fake ballin help\n');
    assert.deepEqual(ballinCalls(), ['']);
    assert.deepEqual(gistReads(), []);
  });

  it('fails help when extra arguments are provided', () => {
    const result = runGu({ args: ['help', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gu help: expected no arguments\n');
    assert.deepEqual(ballinCalls(), []);
    assert.deepEqual(gistReads(), []);
  });

  it('fails unknown commands instead of ignoring them', () => {
    const result = runGu({ args: ['typo'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "gu: unknown command 'typo'\n");
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('fails unknown commands before checking Gist readability', () => {
    const result = runGu({ args: ['typo'], ghInitialReadFail: true });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "gu: unknown command 'typo'\n");
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reads a named Gist file', () => {
    seedFakeGistFile('vimrc', 'set number\n');

    const result = runGu({ args: ['read', 'vimrc'] });

    assertGuSucceeded(result);
    assert.equal(result.stdout, 'set number\n');
    assert.deepEqual(gistReads(), ['vimrc']);
  });

  it('fails read when extra arguments are provided', () => {
    const result = runGu({ args: ['read', 'vimrc', 'extra'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gu read: expected exactly one filename\n');
    assert.deepEqual(gistReads(), []);
  });

  it('streams large Gist files when reading a named file', () => {
    const largeSnapshot = `${'r'.repeat(1024 * 1024 + 1)}\n`;
    seedFakeGistFile('vimrc', largeSnapshot);

    const result = runGu({ args: ['read', 'vimrc'] });

    assertGuSucceeded(result);
    assert.equal(result.stdout.length, largeSnapshot.length);
    assert.equal(result.stdout.slice(0, 1), 'r');
    assert.equal(result.stdout.slice(-1), '\n');
    assert.deepEqual(gistReads(), ['vimrc']);
  });

  it('prints options when a requested Gist file is missing', () => {
    const result = runGu({ args: ['read', 'missing_file'] });

    assert.equal(result.status, 1);
    assert.include(result.stdout, '\nOptions: ');
    assert.include(result.stdout, 'ballin_config');
    assert.include(result.stdout, 'vsI_settings');
    assert.deepEqual(gistReads(), ['missing_file']);
  });

  it('prints options when read is missing a filename', () => {
    const result = runGu({ args: ['read'] });

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Error: 'read' needs a filename.");
    assert.include(result.stdout, '\nOptions: ');
    assert.deepEqual(gistReads(), []);
  });

  it('reports a missing read filename before checking Gist readability', () => {
    const result = runGu({ args: ['read'], ghInitialReadFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stdout, "Error: 'read' needs a filename.");
    assert.include(result.stdout, '\nOptions: ');
    assert.equal(result.stderr, '');
    assert.deepEqual(gistReads(), []);
  });

  it('uses the initial Gist retrieval failure status before snapshotting', () => {
    const result = runGu({ ghInitialReadFail: true });

    assert.equal(result.status, 17);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin_update'.\n");
    assert.equal(result.stderr, 'simulated initial gh gist read failure\n');
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('uses a shell-style signal exit status for initial Gist retrieval', () => {
    const result = runGu({ ghInitialReadSignal: true });

    assert.equal(result.status, 143);
    assert.equal(result.stdout, "Error retrieving your gist, please run 'ballin_update'.\n");
    assert.equal(result.stderr, '');
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports gh authentication failures before snapshotting', () => {
    const result = runGu({ ghAuthFail: true });

    assert.equal(result.status, 4);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'simulated gh auth failure\n'
        + 'gu: GitHub CLI authentication is required for example.test\n'
        + "gu: run 'gh auth login --hostname example.test'\n",
    );
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing gh before snapshotting', () => {
    removeGhCommand();

    const result = runGu();

    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: command not found\n');
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports permission-denied gh before snapshotting', () => {
    makeGhCommandPermissionDenied();

    const result = runGu();

    assert.equal(result.status, 126);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gh: Permission denied\n');
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('preserves config stderr when config reads fail', () => {
    installFailingBallinConfigCommand();

    const result = runGu();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'ballin_config failed for gu.id\n'
        + 'ballin_config failed for gu.host\n'
        + 'gu: missing config value gu.id\n'
        + 'gu: missing config value gu.host\n',
    );
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports missing ballin_config reads before snapshotting', () => {
    removeBallinConfigCommand();

    const result = runGu();

    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'ballin_config: command not found\n'
        + 'ballin_config: command not found\n'
        + 'gu: missing config value gu.id\n'
        + 'gu: missing config value gu.host\n',
    );
    assert.isFalse(fs.existsSync(guCacheDir));
    assert.deepEqual(gistReads(), []);
    assert.deepEqual(gistUploads(), []);
  });

  it('reports permission-denied ballin_config reads before snapshotting', () => {
    makeBallinConfigCommandPermissionDenied();

    const result = runGu();

    assert.equal(result.status, 126);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'ballin_config: Permission denied\n'
        + 'ballin_config: Permission denied\n'
        + 'gu: missing config value gu.id\n'
        + 'gu: missing config value gu.host\n',
    );
    assert.isFalse(fs.existsSync(guCacheDir));
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

    const result = runGu();

    assertGuSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '💾 vs_settings',
      '💾 vs_keybindings',
      '💾 vs_extensions',
      '💾 vsI_settings',
      '💾 vsI_keybindings',
      '💾 vsI_extensions',
    ]);
    assert.equal(fs.readFileSync(path.join(guCacheDir, 'vs_settings'), 'utf8'), '{"fontSize":14}\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'vs_keybindings'), 'utf8'),
      '[{"key":"cmd+k"}]\n',
    );
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'vs_extensions'), 'utf8'),
      'publisher.stable-extension\n',
    );
    assert.equal(fs.readFileSync(path.join(guCacheDir, 'vsI_settings'), 'utf8'), '{"fontSize":15}\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'vsI_keybindings'), 'utf8'),
      '[{"key":"cmd+i"}]\n',
    );
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'vsI_extensions'), 'utf8'),
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

    const result = runGu();

    assertGuSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '💾 brackets_settings',
      '💾 brackets_keymap',
      '💾 brackets_extensions',
      '💾 brackets_disabled_extensions',
    ]);
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'brackets_settings.json'), 'utf8'),
      '{"linting.enabled":true}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'brackets_keymap.json'), 'utf8'),
      '{"Ctrl-E":"edit"}\n',
    );
    assert.equal(fs.readFileSync(path.join(guCacheDir, 'brackets_extensions'), 'utf8'), 'beautify\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'brackets_disabled_extensions'), 'utf8'),
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

    const result = runGu();

    assertGuSucceeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '💾 npm_global',
      '💾 mas',
    ]);
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'npm_global'), 'utf8'),
      '/fake/npm\n+-- eslint@1.0.0\n',
    );
    assert.equal(fs.readFileSync(path.join(guCacheDir, 'mas'), 'utf8'), '123456 Example App\n');
    assert.deepEqual(gistUploads(), ['npm_global', 'mas']);
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

      const result = runGu({ brewPrefix });

      assertGuSucceeded(result);
      assert.include(result.stdout, '💾 bash_completions\n');
      assert.equal(
        fs.readFileSync(path.join(guCacheDir, 'bash_completions'), 'utf8'),
        'git\nnpm\n',
      );
      assert.equal(brewCalls().filter((call: string) => call.endsWith('|--prefix')).length, 1);
      assert.equal(gistUploads().filter((name: string) => name === 'bash_completions').length, 1);
    });
  });

  it('skips bash completions when the active Homebrew completion directory is missing', () => {
    installFakeBrewCommand();

    const result = runGu();

    assertGuSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'bash_completions')));
  });

  it('snapshots only the active prefix when multiple Homebrew prefixes coexist', () => {
    const activePrefix = path.join(testHomeDir, 'active-homebrew');
    const inactivePrefix = path.join(testHomeDir, 'inactive-homebrew');
    installFakeBrewCommand();
    writeBashCompletions(activePrefix, ['active-tool']);
    writeBashCompletions(inactivePrefix, ['inactive-tool']);

    const result = runGu({ brewPrefix: activePrefix });

    assertGuSucceeded(result);
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'bash_completions'), 'utf8'),
      'active-tool\n',
    );
    assert.equal(gistUploads().filter((name: string) => name === 'bash_completions').length, 1);
  });

  it('uses an explicit bash completion directory override when brew is unavailable', () => {
    const appleSiliconPrefix = path.join(testHomeDir, 'opt', 'homebrew');
    const completionDir = path.join(appleSiliconPrefix, 'etc', 'bash_completion.d');
    writeBashCompletions(appleSiliconPrefix, ['apple-silicon-tool']);

    const result = runGu({ completionDir });

    assertGuSucceeded(result);
    assert.equal(result.stdout, '💾 bash_completions\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'bash_completions'), 'utf8'),
      'apple-silicon-tool\n',
    );
    assert.deepEqual(brewCalls(), []);
  });

  it('skips bash completions instead of guessing a prefix when brew is unavailable', () => {
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);
    writeBashCompletions(path.join(testHomeDir, 'usr', 'local'), ['intel-tool']);

    const result = runGu();

    assertGuSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'bash_completions')));
    assert.deepEqual(brewCalls(), []);
  });

  it('skips Homebrew snapshots when brew resolves but is not executable', () => {
    installNonExecutableBrewCommand();
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(brewCalls(), []);
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'bash_completions')));
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'brew_list')));
  });

  it('skips bash completions instead of guessing a prefix when brew prefix discovery fails', () => {
    installFakeBrewCommand();
    writeBashCompletions(path.join(testHomeDir, 'opt', 'homebrew'), ['apple-silicon-tool']);
    writeBashCompletions(path.join(testHomeDir, 'usr', 'local'), ['intel-tool']);

    const result = runGu({ brewPrefixFail: true });

    assertGuSucceeded(result);
    assert.notInclude(result.stdout, 'bash_completions');
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'bash_completions')));
    assert.equal(brewCalls().filter((call: string) => call.endsWith('|--prefix')).length, 1);
  });

  it('captures Homebrew inventory with flags while suppressing successful services stderr', () => {
    installFakeBrewCommand();

    const result = runGu();

    assertGuSucceeded(result);
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
      fs.readFileSync(path.join(guCacheDir, 'brew_services'), 'utf8'),
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

    const result = runGu({ brewServicesFail: true });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'simulated services warning\n');
    assert.include(result.stderr, 'gu: failed to snapshot brew_services\n');
    assert.isFalse(fs.existsSync(path.join(guCacheDir, 'brew_services')));
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

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'alias hello="world"\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'alias hello="world"\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('uses the current new-file icon for a first empty snapshot', () => {
    writeSnapshot('');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '💾 zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'empty\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('hydrates a missing cache from unchanged Gist content', () => {
    writeSnapshot('export EDITOR=vim\n');
    seedFakeGist('export EDITOR=vim\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export EDITOR=vim\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
  });

  it('streams large Gist files when hydrating a missing cache', () => {
    const largeSnapshot = `${'h'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);
    seedFakeGist(largeSnapshot);

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.equal(fs.statSync(cachedSnapshotPath()).size, largeSnapshot.length);
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
  });

  it('compares against hydrated Gist content before uploading a change', () => {
    writeSnapshot('new value\n');
    seedFakeGist('old value\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'new value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'new value\n');
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('reports unchanged non-empty output without uploading it', () => {
    writeSnapshot('set -o vi\n');
    seedGuCache('set -o vi\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✔ zshrc\n');
    assert.deepEqual(gistUploads(), []);
  });

  it('reports and uploads changed non-empty output', () => {
    writeSnapshot('export COLOR=blue\n');
    seedGuCache('export COLOR=red\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('reports a failure when a Gist upload fails', () => {
    writeSnapshot('export COLOR=blue\n');
    seedGuCache('export COLOR=red\n');
    seedFakeGist('export COLOR=red\n');

    const result = runGu({ ghUploadFail: true });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'simulated gh gist upload failure\ngu: failed to snapshot zshrc.sh\n');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=red\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=red\n');
    assert.deepEqual(gistUploads(), []);
  });

  it('retries a changed snapshot after a failed Gist upload', () => {
    writeSnapshot('export COLOR=blue\n');
    seedGuCache('export COLOR=red\n');
    seedFakeGist('export COLOR=red\n');

    const failedResult = runGu({ ghUploadFail: true });
    const retriedResult = runGu();

    assert.equal(failedResult.status, 1);
    assertGuSucceeded(retriedResult);
    assert.equal(retriedResult.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'export COLOR=blue\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'export COLOR=blue\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('streams large snapshot output without the default spawn buffer limit', () => {
    const largeSnapshot = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeSnapshot(largeSnapshot);

    const result = runGu();

    assertGuSucceeded(result);
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

    const result = runGu();

    assert.equal(result.status, 0);
    assert.include(result.stdout, '💾 vs_extensions\n');
    assert.equal(result.stderr.length, 1024 * 1024 + 2);
    assert.equal(result.stderr.slice(0, 1), ' ');
    assert.equal(result.stderr.slice(-1), '\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'vs_extensions'), 'utf8'),
      'publisher.large-stderr\n',
    );
    assert.include(gistUploads(), 'vs_extensions');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports and uploads non-empty output becoming empty', () => {
    writeSnapshot('');
    seedGuCache('old content\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✖︎ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'empty\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('hides unchanged empty output and does not upload it', () => {
    writeSnapshot('');
    seedGuCache('empty\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(gistUploads(), []);
  });

  it('preserves the current changed icon when empty becomes non-empty', () => {
    writeSnapshot('restored\n');
    seedGuCache('empty\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(result.stdout, '✚ zshrc\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('preserves multiple trailing blank lines', () => {
    writeSnapshot('line\n\n\n');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n\n\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'line\n\n\n');
  });

  it('normalizes output missing its final newline', () => {
    writeSnapshot('line');

    const result = runGu();

    assertGuSucceeded(result);
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'line\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'line\n');
  });

  it('uploads a normalized snapshot only once when a later run is unchanged', () => {
    writeSnapshot('stable without newline');

    const firstResult = runGu();
    const secondResult = runGu();

    assertGuSucceeded(firstResult);
    assertGuSucceeded(secondResult);
    assert.equal(secondResult.stdout, '✔ zshrc\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('preserves failed snapshot state, adds context, and continues later snapshots', () => {
    const gitconfigPath = path.join(testHomeDir, '.gitconfig');
    writeSnapshot('new zsh value\n');
    fs.writeFileSync(gitconfigPath, 'new git value\n');
    seedGuCache('old zsh value\n');
    seedFakeGist('old zsh value\n');

    const result = runGu({
      failedPaths: ['.zshrc'],
      emitUnderlyingStderr: true,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '💾 gitconfig\n');
    assert.equal(
      result.stderr,
      'cat: simulated failure reading .zshrc\n'
        + 'gu: failed to snapshot zshrc.sh\n',
    );
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'old zsh value\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'old zsh value\n');
    assert.equal(
      fs.readFileSync(path.join(guCacheDir, 'gitconfig'), 'utf8'),
      'new git value\n',
    );
    assert.deepEqual(gistUploads(), ['gitconfig']);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('reports a silent command failure without leaving failed Gist hydration behind', () => {
    writeSnapshot('not captured\n');

    const result = runGu({ failedPaths: ['.zshrc'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'gu: failed to snapshot zshrc.sh\n');
    assert.isFalse(fs.existsSync(cachedSnapshotPath()));
    assert.isFalse(fs.existsSync(fakeGistFilePath()));
    assert.deepEqual(gistReads(), [snapshotFileName]);
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });

  it('recovers cleanly on the next successful invocation', () => {
    writeSnapshot('recovered\n');
    seedGuCache('before failure\n');
    seedFakeGist('before failure\n');

    const failedResult = runGu({ failedPaths: ['.zshrc'] });
    const recoveredResult = runGu();

    assert.equal(failedResult.status, 1);
    assertGuSucceeded(recoveredResult);
    assert.equal(recoveredResult.stdout, '✚ zshrc\n');
    assert.equal(fs.readFileSync(cachedSnapshotPath(), 'utf8'), 'recovered\n');
    assert.equal(fs.readFileSync(fakeGistFilePath(), 'utf8'), 'recovered\n');
    assert.deepEqual(gistUploads(), [snapshotFileName]);
  });

  it('returns one predictable failure status after multiple snapshot failures', () => {
    const gitconfigPath = path.join(testHomeDir, '.gitconfig');
    writeSnapshot('zsh value\n');
    fs.writeFileSync(gitconfigPath, 'git value\n');

    const result = runGu({ failedPaths: ['.zshrc', '.gitconfig'] });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'gu: failed to snapshot zshrc.sh\n'
        + 'gu: failed to snapshot gitconfig\n',
    );
    assert.deepEqual(gistUploads(), []);
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  });
});
