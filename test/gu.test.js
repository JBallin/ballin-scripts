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
];

describe('gu', () => {
  let testHomeDir;
  let testBinDir;
  let guCacheDir;
  let fakeGistDir;
  let gistReadLogPath;
  let scratchDir;
  let gistUploadLogPath;
  let brewLogPath;
  let realCatPath;

  const linkRequiredCommand = (command) => {
    const commandPath = process.env.PATH
      .split(path.delimiter)
      .map((directory) => path.join(directory, command))
      .find((candidate) => fs.existsSync(candidate));

    assert.exists(commandPath, `${command} is required to run the gu test harness`);
    fs.symlinkSync(commandPath, path.join(testBinDir, command));
  };

  const writeTestExecutable = (name, contents) => {
    fs.writeFileSync(path.join(testBinDir, name), contents, { mode: 0o755 });
  };

  const installFakeBallinConfigCommand = () => {
    writeTestExecutable('ballin_config', `#!/usr/bin/env bash
if [ "$1" != 'get' ]; then
  printf '%s\\n' 'Unexpected ballin_config action' >&2
  exit 2
elif [ "$2" = 'gu.id' ]; then
  printf '%s\\n' 'test-gist-id'
elif [ "$2" = 'gu.url' ]; then
  printf '%s\\n' 'https://example.test/gists'
else
  printf '%s\\n' 'Unexpected ballin_config call' >&2
  exit 2
fi
`);
  };

  const installFakeGistCommand = () => {
    // Store the fake remote Gist as ordinary files inside the temporary test home.
    writeTestExecutable('gist', `#!/usr/bin/env bash
if [ "$2" != 'test-gist-id' ]; then
  printf '%s\\n' 'Unexpected Gist ID' >&2
  exit 2
fi
if [ "$1" = '-r' ]; then
  if [ "$#" -eq 2 ]; then
    exit 0
  elif [ "$#" -ne 3 ]; then
    printf '%s\\n' 'Unexpected gist read arguments' >&2
    exit 2
  fi
  printf '%s\\n' "$3" >> "$FAKE_GIST_READ_LOG"
  fake_gist_file="$FAKE_GIST_STORAGE_DIR/$3"
  if [ -f "$fake_gist_file" ]; then
    cat "$fake_gist_file"
  else
    exit 1
  fi
elif [ "$1" = '-u' ]; then
  if [ "$#" -ne 3 ]; then
    printf '%s\\n' 'Unexpected gist upload arguments' >&2
    exit 2
  fi
  cache_file="$3"
  file_name="\${cache_file##*/}"
  cp "$cache_file" "$FAKE_GIST_STORAGE_DIR/$file_name"
  printf '%s\\n' "$file_name" >> "$FAKE_GIST_UPLOAD_LOG"
else
  printf '%s\\n' 'Unexpected gist call' >&2
  exit 2
fi
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
    installFakeGistCommand();
  });

  afterEach(() => {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  });

  // Pass a complete child environment so real tools and credentials are not inherited.
  const runGu = ({
    failedPaths = [],
    emitUnderlyingStderr = false,
    brewServicesFail = false,
    brewPrefix = path.join(testHomeDir, 'opt', 'homebrew'),
    brewPrefixFail = false,
    completionDir,
  } = {}) => spawnSync(guPath, [], {
    encoding: 'utf8',
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
      FAKE_BREW_LOG: brewLogPath,
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
  const writeSnapshot = (content) => fs.writeFileSync(snapshotPath(), content);
  const seedGuCache = (content) => {
    fs.mkdirSync(guCacheDir, { recursive: true });
    fs.writeFileSync(cachedSnapshotPath(), content);
  };
  const seedFakeGist = (content) => fs.writeFileSync(fakeGistFilePath(), content);
  const assertGuSucceeded = (result) => {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(scratchDir), []);
  };
  const readLogLines = (logPath) => (
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
  );
  const gistReads = () => readLogLines(gistReadLogPath);
  const gistUploads = () => readLogLines(gistUploadLogPath);
  const brewCalls = () => readLogLines(brewLogPath);

  const writeBashCompletions = (brewPrefix, names) => {
    const completionDirectory = path.join(brewPrefix, 'etc', 'bash_completion.d');
    fs.mkdirSync(completionDirectory, { recursive: true });
    names.forEach((name) => fs.writeFileSync(path.join(completionDirectory, name), ''));
  };

  [
    ['Apple Silicon', path.join('opt', 'homebrew')],
    ['Intel', path.join('usr', 'local')],
    ['custom', path.join('srv', 'custombrew')],
  ].forEach(([label, relativePrefix]) => {
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
      assert.equal(brewCalls().filter((call) => call.endsWith('|--prefix')).length, 1);
      assert.equal(gistUploads().filter((name) => name === 'bash_completions').length, 1);
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
    assert.equal(gistUploads().filter((name) => name === 'bash_completions').length, 1);
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
    assert.equal(brewCalls().filter((call) => call.endsWith('|--prefix')).length, 1);
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
