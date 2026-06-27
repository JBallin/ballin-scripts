const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const updatePath = path.join(__dirname, '..', 'bin', 'ballin_update');
type SpawnUpdateOverrides = Omit<
  import('child_process').SpawnSyncOptionsWithStringEncoding,
  'encoding' | 'env'
>;

describe('ballin_update', () => {
  let testDir: string;
  let homeDir: string;
  let repoDir: string;
  let toolDir: string;
  let commandLogPath: string;
  let mergeCountPath: string;

  const commandPath = (name: string) => (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate));

  const writeExecutable = (name: string, contents: string, directory = toolDir) => {
    const executablePath = path.join(directory, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const linkCommand = (name: string) => {
    const sourcePath = commandPath(name);
    assert.exists(sourcePath, `${name} is required to run the ballin_update test harness`);
    fs.symlinkSync(sourcePath, path.join(toolDir, name));
  };

  const installGitStub = () => {
    writeExecutable('git', `#!/usr/bin/env bash
printf '%s|git:%s\\n' "$PWD" "$*" >> "$BALLIN_UPDATE_TEST_LOG"
case "$1" in
  fetch)
    if [ "$FAKE_GIT_FETCH_READ_STDIN" = '1' ]; then
      printf 'credential prompt\\n' >&2
      if ! IFS= read -r answer; then
        exit 31
      fi
      printf 'fetch-stdin:%s\\n' "$answer" >> "$BALLIN_UPDATE_TEST_LOG"
    fi
    printf 'fetch stdout should stay hidden\\n'
    exit "$FAKE_GIT_FETCH_STATUS"
    ;;
  merge)
    count=0
    if [ -f "$FAKE_GIT_MERGE_COUNT_PATH" ]; then
      count="$(cat "$FAKE_GIT_MERGE_COUNT_PATH")"
    fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$FAKE_GIT_MERGE_COUNT_PATH"
    if [ "$count" -eq 1 ]; then
      exit "$FAKE_GIT_FIRST_MERGE_STATUS"
    fi
    exit "$FAKE_GIT_RETRY_MERGE_STATUS"
    ;;
  add)
    exit "$FAKE_GIT_ADD_STATUS"
    ;;
  stash)
    exit "$FAKE_GIT_STASH_STATUS"
    ;;
  checkout)
    exit "$FAKE_GIT_CHECKOUT_STATUS"
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  };

  const installInstallerStub = () => {
    writeExecutable('install.sh', `#!/usr/bin/env bash
printf '%s|install.sh:%s\\n' "$PWD" "$*" >> "$BALLIN_UPDATE_TEST_LOG"
exit "$FAKE_INSTALL_STATUS"
`, repoDir);
  };

  const runUpdate = (
    env: NodeJS.ProcessEnv = {},
    commandPath = updatePath,
    spawnOptions: SpawnUpdateOverrides = {},
  ) => spawnSync(commandPath, [], {
    ...spawnOptions,
    encoding: 'utf8',
    env: {
      HOME: homeDir,
      PATH: toolDir,
      BALLIN_UPDATE_TEST_LOG: commandLogPath,
      FAKE_GIT_MERGE_COUNT_PATH: mergeCountPath,
      FAKE_GIT_FETCH_STATUS: '0',
      FAKE_GIT_FIRST_MERGE_STATUS: '0',
      FAKE_GIT_RETRY_MERGE_STATUS: '0',
      FAKE_GIT_ADD_STATUS: '0',
      FAKE_GIT_STASH_STATUS: '0',
      FAKE_GIT_CHECKOUT_STATUS: '0',
      FAKE_INSTALL_STATUS: '0',
      ...env,
    },
  });

  const commandLog = () => (
    fs.existsSync(commandLogPath)
      ? fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').filter(Boolean)
      : []
  );

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-update-'));
    homeDir = path.join(testDir, 'home');
    repoDir = path.join(homeDir, '.ballin-scripts');
    toolDir = path.join(testDir, 'tools');
    commandLogPath = path.join(testDir, 'commands.log');
    mergeCountPath = path.join(testDir, 'merge-count');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(toolDir);
    linkCommand('bash');
    linkCommand('cat');
    fs.symlinkSync(process.execPath, path.join(toolDir, 'node'));
    installGitStub();
    installInstallerStub();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('fetches, merges, then runs the installer from the installed repository', () => {
    const result = runUpdate();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '👟 getting fresh kicks...\n\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|install.sh:`,
    ]);
  });

  it('lets fetch use stdin and stderr while keeping stdout quiet', () => {
    const result = runUpdate(
      { FAKE_GIT_FETCH_READ_STDIN: '1' },
      updatePath,
      { input: 'secret-token\n' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '👟 getting fresh kicks...\n\n');
    assert.equal(result.stderr, 'credential prompt\n');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      'fetch-stdin:secret-token',
      `${repoDir}|git:merge`,
      `${repoDir}|install.sh:`,
    ]);
  });

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(testDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'ballin_update');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(updatePath, symlinkPath);

    const result = runUpdate({}, symlinkPath);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '👟 getting fresh kicks...\n\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|install.sh:`,
    ]);
  });

  it('returns the installer status when install fails after a successful merge', () => {
    const result = runUpdate({ FAKE_INSTALL_STATUS: '27' });

    assert.equal(result.status, 27);
    assert.equal(result.stdout, '👟 getting fresh kicks...\n\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|install.sh:`,
    ]);
  });

  it('stops before merge and install when fetch fails', () => {
    const result = runUpdate({ FAKE_GIT_FETCH_STATUS: '23' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '👟 getting fresh kicks...\ngit fetch failed\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
    ]);
  });

  it('stashes, checks out main, retries merge, and installs after an initial merge failure', () => {
    const result = runUpdate({ FAKE_GIT_FIRST_MERGE_STATUS: '24' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      '👟 getting fresh kicks...\ngit merge failed. stashing changes and trying again...\n\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|git:add .`,
      `${repoDir}|git:stash`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge`,
      `${repoDir}|install.sh:`,
    ]);
  });

  it('stops before install when the retry merge fails', () => {
    const result = runUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_RETRY_MERGE_STATUS: '25',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      '👟 getting fresh kicks...\n'
        + 'git merge failed. stashing changes and trying again...\n'
        + 'git merge failed again.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|git:add .`,
      `${repoDir}|git:stash`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge`,
    ]);
  });

  it('stops before retry merge and install when the fallback stash path fails', () => {
    const result = runUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_STASH_STATUS: '26',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      '👟 getting fresh kicks...\n'
        + 'git merge failed. stashing changes and trying again...\n'
        + 'git merge failed again.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch`,
      `${repoDir}|git:merge`,
      `${repoDir}|git:add .`,
      `${repoDir}|git:stash`,
    ]);
  });
});
