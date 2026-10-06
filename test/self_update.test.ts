const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
const docsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md';
const analyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const updateLine = 'Updating Ballin...\n';
type SpawnSelfUpdateOverrides = Omit<
  import('child_process').SpawnSyncOptionsWithStringEncoding,
  'encoding' | 'env'
>;

describe('ballin self-update', () => {
  let testDir: string;
  let homeDir: string;
  let repoDir: string;
  let toolDir: string;
  let commandLogPath: string;
  let mergeCountPath: string;
  let checkoutCountPath: string;

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
    assert.exists(sourcePath, `${name} is required to run the ballin self-update test harness`);
    fs.symlinkSync(sourcePath, path.join(toolDir, name));
  };

  const installGitStub = () => {
    writeExecutable('git', `#!/usr/bin/env bash
printf '%s|git:%s\\n' "$PWD" "$*" >> "$BALLIN_UPDATE_TEST_LOG"
printf '%s|%s\\n' "$*" "$GIT_NO_LAZY_FETCH" >> "$BALLIN_UPDATE_TEST_LOCAL_GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$2" = '--verify' ] && [ "$3" = 'HEAD' ]; then
      if [ -z "$FAKE_HEAD_BEFORE" ]; then exit 1; fi
      if [ -f "$FAKE_GIT_MERGE_COUNT_PATH" ]; then
        if [ "\${FAKE_HEAD_POST_STATUS:-0}" != 0 ]; then exit "$FAKE_HEAD_POST_STATUS"; fi
        printf '%s\\n' "\${FAKE_HEAD_AFTER:-$FAKE_HEAD_BEFORE}"
      else printf '%s\\n' "$FAKE_HEAD_BEFORE"; fi
      exit 0
    fi
    if [ "$2" = '--short=7' ]; then
      if [ "\${FAKE_ABBREV_STATUS:-0}" != 0 ]; then exit "$FAKE_ABBREV_STATUS"; fi
      if [ -n "$FAKE_ABBREV" ]; then printf '%s\\n' "$FAKE_ABBREV";
      else printf '%.*s\\n' "\${FAKE_ABBREV_LENGTH:-7}" "$4"; fi
      exit 0
    fi
    if [ "$2" = '--is-shallow-repository' ]; then
      printf '%s\\n' "\${FAKE_SHALLOW:-false}"
      exit "\${FAKE_SHALLOW_STATUS:-0}"
    fi
    if [ "$2" = '--verify' ] && [ "$3" = 'HEAD:commands/backup_snapshots.ts' ]; then
      if [ -f "$FAKE_GIT_MERGE_COUNT_PATH" ]; then
        if [ "\${FAKE_SOURCE_POST_STATUS:-0}" != '0' ]; then exit "$FAKE_SOURCE_POST_STATUS"; fi
        if [ "\${FAKE_SOURCE_CHANGED:-0}" = '1' ]; then
          printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
          exit 0
        fi
      elif [ "\${FAKE_SOURCE_PRE_STATUS:-0}" != '0' ]; then exit "$FAKE_SOURCE_PRE_STATUS"; fi
      printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      exit 0
    fi
    if [ "$FAKE_GIT_MERGE_IN_PROGRESS" = '1' ]; then
      exit 0
    fi
    exit 1
    ;;
  config)
    if [ "$FAKE_PROMISOR" = 1 ]; then printf 'remote.origin.promisor true\\n'; exit 0; fi
    exit "\${FAKE_CONFIG_STATUS:-1}"
    ;;
  merge-base) exit "\${FAKE_ANCESTRY_STATUS:-0}" ;;
  rev-list)
    printf '%s\\n' "\${FAKE_NEW_COMMITS:-6}"
    exit "\${FAKE_COUNT_STATUS:-0}"
    ;;
  fetch)
    printf '%s' "$FAKE_GIT_FETCH_STDERR" >&2
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
    if [ "$2" = '--abort' ]; then
      exit "$FAKE_GIT_MERGE_ABORT_STATUS"
    fi
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
  stash)
    exit "$FAKE_GIT_STASH_STATUS"
    ;;
  checkout)
    count=0
    if [ -f "$FAKE_GIT_CHECKOUT_COUNT_PATH" ]; then
      count="$(cat "$FAKE_GIT_CHECKOUT_COUNT_PATH")"
    fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$FAKE_GIT_CHECKOUT_COUNT_PATH"
    if [ "$count" -eq 1 ]; then
      exit "$FAKE_GIT_FIRST_CHECKOUT_STATUS"
    fi
    exit "$FAKE_GIT_RETRY_CHECKOUT_STATUS"
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  };

  const installSetupStub = () => {
    const commandsDir = path.join(repoDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'install_setup.ts'), `const fs = require('fs');
fs.appendFileSync(process.env.BALLIN_UPDATE_TEST_LOG, process.cwd() + '|install_setup:' + process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(process.env.FAKE_SETUP_STDOUT || '');
process.stderr.write(process.env.FAKE_SETUP_STDERR || '');
if (process.env.FAKE_SETUP_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_SETUP_SIGNAL);
}
process.exit(Number(process.env.FAKE_SETUP_STATUS || '0'));
`);
  };

  const runSelfUpdate = (
    env: NodeJS.ProcessEnv = {},
    commandPath = ballinPath,
    spawnOptions: SpawnSelfUpdateOverrides = {},
    args: string[] = ['self-update'],
  ) => spawnSync(commandPath, args, {
    ...spawnOptions,
    encoding: 'utf8',
    env: {
      HOME: homeDir,
      PATH: toolDir,
      BALLIN_NO_ANALYTICS: '1',
      BALLIN_UPDATE_TEST_LOG: commandLogPath,
      BALLIN_UPDATE_TEST_LOCAL_GIT_LOG: path.join(testDir, 'local-git.log'),
      FAKE_GIT_MERGE_COUNT_PATH: mergeCountPath,
      FAKE_GIT_CHECKOUT_COUNT_PATH: checkoutCountPath,
      FAKE_GIT_FETCH_STATUS: '0',
      FAKE_GIT_FIRST_MERGE_STATUS: '0',
      FAKE_GIT_RETRY_MERGE_STATUS: '0',
      FAKE_GIT_MERGE_IN_PROGRESS: '0',
      FAKE_GIT_MERGE_ABORT_STATUS: '0',
      FAKE_GIT_STASH_STATUS: '0',
      FAKE_GIT_FIRST_CHECKOUT_STATUS: '0',
      FAKE_GIT_RETRY_CHECKOUT_STATUS: '0',
      FAKE_SETUP_STATUS: '0',
      ...env,
    },
  });

  const commandLog = (includeSourceChecks = false) => (
    fs.existsSync(commandLogPath)
      ? fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').filter((line: string) => line
        && (includeSourceChecks || !line.endsWith('|git:rev-parse --verify HEAD:commands/backup_snapshots.ts'))
        && !line.endsWith('|git:rev-parse --verify HEAD')
        && !/\|git:(rev-parse --short=7|rev-parse --is-shallow-repository|config --get-regexp|merge-base --is-ancestor|rev-list --count)/u.test(line))
      : []
  );

  const setupLog = () => `${fs.realpathSync(repoDir)}|install_setup:setup ${repoDir} ${docsUrl} ${analyticsDocsUrl} self-update`;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-update-'));
    homeDir = path.join(testDir, 'home');
    repoDir = path.join(homeDir, '.ballin-scripts');
    toolDir = path.join(testDir, 'tools');
    commandLogPath = path.join(testDir, 'commands.log');
    mergeCountPath = path.join(testDir, 'merge-count');
    checkoutCountPath = path.join(testDir, 'checkout-count');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(toolDir);
    linkCommand('bash');
    linkCommand('cat');
    fs.symlinkSync(process.execPath, path.join(toolDir, 'node'));
    installGitStub();
    installSetupStub();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const interactiveEnv = (nonTTY?: 'stdin' | 'stdout' | 'stderr', columns = 80): NodeJS.ProcessEnv => {
    const preload = path.join(testDir, 'interactive.cjs');
    fs.writeFileSync(preload, `
      for (const name of ['stdin', 'stdout', 'stderr']) Object.defineProperty(process[name], 'isTTY', { value: name !== ${JSON.stringify(nonTTY ?? '')} });
      Object.defineProperty(process.stderr, 'columns', { value: ${columns} });
      const fs = require('fs'); const write = fs.writeSync;
      let feedback = '';
      fs.writeSync = function(fd, text, ...rest) { if (fd === 2) feedback += text; return write.call(this, fd, text, ...rest); };
      let stdout = ''; const stdoutWrite = process.stdout.write;
      process.stdout.write = function(text, ...rest) { stdout += text; return stdoutWrite.call(this, text, ...rest); };
      const child = require('child_process'); const spawn = child.spawnSync;
      child.spawnSync = function(command, args, options) {
        if (command === 'git' && args[0] === 'fetch') fs.writeFileSync(${JSON.stringify(path.join(testDir, 'fetch-feedback.json'))}, JSON.stringify({ feedback, stdout, args, stdio: options.stdio }));
        return spawn.call(this, command, args, options);
      };
    `);
    return { NODE_OPTIONS: `--require=${preload}`, TERM: 'xterm', NO_COLOR: '' };
  };

  for (const mode of ['stdin', 'stdout', 'stderr', 'dumb', 'NO_COLOR', 'narrow'] as const) {
    it(`prints plain permanent self-update progress in ${mode} mode`, () => {
      const env = interactiveEnv(['stdin', 'stdout', 'stderr'].includes(mode) ? mode as 'stdin' | 'stdout' | 'stderr' : undefined, mode === 'narrow' ? 10 : 80);
      if (mode === 'dumb') env.TERM = 'dumb';
      if (mode === 'NO_COLOR') env.NO_COLOR = '1';
      const result = runSelfUpdate(env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
      assert.equal(result.stderr, '');
    });
  }
  it('reports a missing installed repository after the update heading without child work', () => {
    const env = interactiveEnv();
    fs.rmSync(repoDir, { recursive: true, force: true });
    const result = runSelfUpdate(env);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, updateLine + `install directory not found: ${repoDir}\n`);
    assert.deepEqual(commandLog(), []);
  });

  it('prints one permanent heading before quiet fetch while preserving inherited streams', () => {
    const result = runSelfUpdate(interactiveEnv());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(testDir, 'fetch-feedback.json'), 'utf8')), {
      feedback: '', stdout: updateLine, args: ['fetch', '--quiet', 'origin', '+main:refs/remotes/origin/main'],
      stdio: ['inherit', 'ignore', 'inherit'],
    });
  });
  const revisions = { FAKE_HEAD_BEFORE: 'a'.repeat(40), FAKE_HEAD_AFTER: 'b'.repeat(40) };
  it('reports an unchanged installed revision after still completing setup', () => {
    const result = runSelfUpdate({ ...revisions, FAKE_HEAD_AFTER: revisions.FAKE_HEAD_BEFORE });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'Ballin is already up to date.\n');
    assert.include(commandLog(), setupLog());
  });
  for (const count of [1, 6]) {
    it(`reports changed revisions with ${count} locally known new commit${count === 1 ? '' : 's'}`, () => {
      const result = runSelfUpdate({ ...revisions, FAKE_NEW_COMMITS: String(count), GIT_NO_LAZY_FETCH: '0' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, updateLine + `Ballin updated: aaaaaaa to bbbbbbb (${count} new commit${count === 1 ? '' : 's'}).\n`);
      const metadata = fs.readFileSync(path.join(testDir, 'local-git.log'), 'utf8').trim().split('\n')
        .filter((line: string) => /^(rev-parse --verify HEAD\||rev-parse --short=7|rev-parse --is-shallow-repository|config --get-regexp|merge-base --is-ancestor|rev-list --count)/u.test(line));
      assert.isAbove(metadata.length, 0);
      assert.isTrue(metadata.every((line: string) => line.endsWith('|1')));
      assert.equal(commandLog().filter((line: string) => line.includes('|git:fetch ')).length, 1);
    });
  }
  for (const env of [
    { FAKE_SHALLOW: 'true' }, { FAKE_SHALLOW: 'unknown' }, { FAKE_SHALLOW_STATUS: '1' },
    { FAKE_PROMISOR: '1' }, { FAKE_CONFIG_STATUS: '2' },
    { FAKE_ANCESTRY_STATUS: '1' }, { FAKE_ANCESTRY_STATUS: '2' }, { FAKE_COUNT_STATUS: '128' },
    { FAKE_NEW_COMMITS: 'invalid' }, { FAKE_NEW_COMMITS: '0' }, { FAKE_NEW_COMMITS: '9007199254740992' },
  ]) {
    it(`keeps revision details when a local count is unavailable: ${JSON.stringify(env)}`, () => {
      const result = runSelfUpdate({ ...revisions, ...env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, updateLine + 'Ballin updated: aaaaaaa to bbbbbbb.\n');
      assert.equal(result.stderr, '');
      assert.equal(commandLog().filter((line: string) => line.includes('|git:fetch ')).length, 1);
    });
  }
  for (const env of [
    { FAKE_HEAD_BEFORE: 'unavailable' }, { FAKE_HEAD_POST_STATUS: '1' },
    { FAKE_ABBREV_STATUS: '1' }, { FAKE_ABBREV: 'invalid' }, { FAKE_ABBREV: 'ccccccc' },
  ]) {
    it(`retains generic success when revision details are unavailable: ${JSON.stringify(env)}`, () => {
      const result = runSelfUpdate({ ...revisions, ...env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    });
  }
  it('compares full SHA-256 revisions even when their short prefixes match', () => {
    const result = runSelfUpdate({
      FAKE_HEAD_BEFORE: 'a'.repeat(7) + 'b'.repeat(57), FAKE_HEAD_AFTER: 'a'.repeat(7) + 'c'.repeat(57),
      FAKE_ABBREV_LENGTH: '8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'Ballin updated: aaaaaaab to aaaaaaac (6 new commits).\n');
  });
  for (const query of ['merge-base', 'rev-list']) {
    it(`keeps successful revision details when optional ${query} metadata throws`, () => {
      const preload = path.join(testDir, 'optional-metadata.cjs');
      fs.writeFileSync(preload, `
        const child = require('child_process'); const original = child.spawnSync;
        child.spawnSync = function(command, args, ...rest) {
          if (command === 'git' && args[0] === ${JSON.stringify(query)}) throw new Error('fixture metadata failure');
          return original.call(this, command, args, ...rest);
        };
      `);
      const result = runSelfUpdate({ ...revisions, NODE_OPTIONS: `--require=${preload}` });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, updateLine + 'Ballin updated: aaaaaaa to bbbbbbb.\n');
      assert.equal(result.stderr, '');
    });
  }
  it('preserves inherited credential and setup output after the permanent heading', () => {
    const result = runSelfUpdate({
      ...interactiveEnv(), FAKE_GIT_FETCH_READ_STDIN: '1', FAKE_SETUP_STDERR: 'setup warning without newline',
    }, ballinPath, { input: 'fixture-credential\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, 'credential prompt\nsetup warning without newline');
    assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    assert.include(commandLog(), 'fetch-stdin:fixture-credential');
  });
  it('preserves fetch diagnostics without a trailing newline and does not erase them on failure', () => {
    const result = runSelfUpdate({ ...interactiveEnv(), FAKE_GIT_FETCH_STDERR: 'fetch diagnostic', FAKE_GIT_FETCH_STATUS: '17' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'fetch diagnostic');
    assert.equal(result.stdout, updateLine + 'git fetch origin main failed\n');
  });
  for (const [setting, value, status] of [
    ['FAKE_GIT_FETCH_STATUS', '17', 1],
    ['FAKE_SETUP_STATUS', '27', 27],
    ['FAKE_SETUP_SIGNAL', 'SIGTERM', 143],
  ] as const) {
    it(`preserves ${setting} failure status without a success completion`, () => {
      const result = runSelfUpdate({ ...interactiveEnv(), [setting]: value });
      assert.equal(result.status, status);
      assert.equal(result.stderr, '');
      assert.notInclude(result.stdout, 'Ballin updated.');
    });
  }
  it('keeps the embedded update headings and readiness check', () => {
    const configPath = path.join(testDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/.defaultConfig.json'), 'utf8'));
    config.update = Object.fromEntries(Object.keys(config.update).map((key) => [key, key === 'selfUpdate' ? 'true' : 'false']));
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.symlinkSync(ballinPath, path.join(toolDir, 'ballin'));
    const result = runSelfUpdate({
      ...interactiveEnv(), BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_BALLIN_PATH: ballinPath,
    }, ballinPath, {}, ['update']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.include(result.stdout, '==> Updating Ballin');
    assert.equal(result.stdout.split(updateLine).length - 1, 1);
    assert.include(result.stdout, 'Ballin updated.');
    assert.include(result.stdout, '==> Checking Ballin readiness');
    assert.notInclude(result.stdout, 'Updating...');
  });

  it('discloses changed backup definitions after successful refresh without executing them', () => {
    const result = runSelfUpdate({ FAKE_SOURCE_CHANGED: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Backup source definitions may have changed.');
    assert.include(result.stdout, 'Sensitive-source opt-in covers current and future supported sources.\nReview: https://github.com/JBallin/ballin-scripts/blob/main/docs/backup-sources.md\n');
    assert.equal(commandLog(true).filter((line: string) => line.includes('HEAD:commands/backup_snapshots.ts')).length, 2);
    assert.isBelow(result.stdout.indexOf('Ballin updated.'), result.stdout.indexOf('Backup source definitions'));
  });

  ['FAKE_SOURCE_PRE_STATUS', 'FAKE_SOURCE_POST_STATUS'].forEach((setting) => {
    it(`keeps a successful update successful when the ${setting} comparison is unavailable`, () => {
      const result = runSelfUpdate({ [setting]: '1' });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Ballin updated.');
      assert.include(result.stdout, 'Backup source definitions may have changed.');
      assert.equal(result.stderr, '');
    });
  });

  it('does not disclose possible source changes when refresh failed', () => {
    const result = runSelfUpdate({ FAKE_SOURCE_CHANGED: '1', FAKE_SETUP_STATUS: '7' });
    assert.equal(result.status, 7);
    assert.notInclude(result.stdout, 'Backup source definitions');
    assert.equal(commandLog(true).filter((line: string) => line.includes('HEAD:commands/backup_snapshots.ts')).length, 1);
  });

  it('fetches, merges, then runs the setup from the installed repository', () => {
    const result = runSelfUpdate();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('preserves setup stdout, stderr and failure status', () => {
    const result = runSelfUpdate({
      FAKE_SETUP_STDOUT: 'operational output\n',
      FAKE_SETUP_STDERR: 'setup warning\n',
      FAKE_SETUP_STATUS: '19',
    });

    assert.equal(result.status, 19);
    assert.equal(result.stdout, updateLine + 'operational output\n');
    assert.equal(result.stderr, 'setup warning\n');
    assert.equal(commandLog().at(-1), setupLog());
  });

  it('preserves fetch failure output without a success completion', () => {
    const result = runSelfUpdate({ FAKE_GIT_FETCH_STATUS: '17' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, updateLine + 'git fetch origin main failed\n');
    assert.notInclude(commandLog().join('\n'), 'install_setup:');
  });

  it('does not add a blank line before setup output', () => {
    const result = runSelfUpdate({
      FAKE_SETUP_STDOUT: 'setup output\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'setup output\nBallin updated.\n');
    assert.equal(result.stderr, '');
  });

  it('lets fetch use stdin and stderr while keeping stdout quiet', () => {
    const result = runSelfUpdate(
      { FAKE_GIT_FETCH_READ_STDIN: '1' },
      ballinPath,
      { input: 'secret-token\n' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    assert.equal(result.stderr, 'credential prompt\n');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      'fetch-stdin:secret-token',
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(testDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'ballin');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(ballinPath, symlinkPath);

    const result = runSelfUpdate({}, symlinkPath);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, updateLine + 'Ballin updated.\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('returns the setup status when setup fails after a successful merge', () => {
    const result = runSelfUpdate({ FAKE_SETUP_STATUS: '27' });

    assert.equal(result.status, 27);
    assert.equal(result.stdout, updateLine);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('reports a missing setup through Node when the typed setup file is unavailable', () => {
    fs.rmSync(path.join(repoDir, 'commands', 'install_setup.ts'));

    const result = runSelfUpdate();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, updateLine);
    assert.include(result.stderr, 'Cannot find module');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
    ]);
  });

  it('uses a shell-style signal exit status when the setup is signaled', () => {
    const result = runSelfUpdate({ FAKE_SETUP_SIGNAL: 'SIGTERM' });

    assert.equal(result.status, 143);
    assert.equal(result.stdout, updateLine);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('stops before merge and setup when fetch fails', () => {
    const result = runSelfUpdate({ FAKE_GIT_FETCH_STATUS: '23' });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, updateLine + 'git fetch origin main failed\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
    ]);
  });

  it('stops before git commands when the installed repository is missing', () => {
    fs.rmSync(repoDir, { recursive: true, force: true });

    const result = runSelfUpdate();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, updateLine + `install directory not found: ${repoDir}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('stops before git commands when the installed repository path is not a directory', () => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.writeFileSync(repoDir, '');

    const result = runSelfUpdate();

    assert.equal(result.status, 1);
    assert.equal(result.stdout, updateLine + `install directory not found: ${repoDir}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('stashes, retries checkout main, merges, and runs setup when initial checkout is blocked', () => {
    const result = runSelfUpdate({ FAKE_GIT_FIRST_CHECKOUT_STATUS: '27' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      updateLine + 'git checkout main failed. stashing changes and trying again...\nBallin updated.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('stops before merge and setup when checkout recovery cannot stash changes', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_CHECKOUT_STATUS: '27',
      FAKE_GIT_STASH_STATUS: '28',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git checkout main failed. stashing changes and trying again...\n'
        + 'git stash failed during checkout recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
    ]);
  });

  it('stops before merge and setup when checkout still fails after stashing', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_CHECKOUT_STATUS: '27',
      FAKE_GIT_RETRY_CHECKOUT_STATUS: '28',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git checkout main failed. stashing changes and trying again...\n'
        + 'git checkout failed during checkout recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
    ]);
  });

  it('stashes, checks out main, retries merge, and runs setup after an initial merge failure', () => {
    const result = runSelfUpdate({ FAKE_GIT_FIRST_MERGE_STATUS: '24' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\nBallin updated.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('aborts an in-progress failed merge before stashing changes during recovery', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_MERGE_IN_PROGRESS: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\nBallin updated.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:merge --abort`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      setupLog(),
    ]);
  });

  it('stops before stashing when aborting an in-progress failed merge fails', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_MERGE_IN_PROGRESS: '1',
      FAKE_GIT_MERGE_ABORT_STATUS: '29',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\n'
        + 'git merge abort failed during merge recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:merge --abort`,
    ]);
  });

  it('stops before setup when the retry merge fails', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_RETRY_MERGE_STATUS: '25',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\n'
        + 'git merge failed during merge recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
    ]);
  });

  it('stops before retry merge and setup when the fallback stash path fails', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_STASH_STATUS: '26',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\n'
        + 'git stash failed during merge recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
    ]);
  });

  it('stops before retry merge and setup when the fallback checkout fails', () => {
    const result = runSelfUpdate({
      FAKE_GIT_FIRST_MERGE_STATUS: '24',
      FAKE_GIT_RETRY_CHECKOUT_STATUS: '27',
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      updateLine + 'git merge failed. stashing changes and trying again...\n'
        + 'git checkout failed during merge recovery.\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), [
      `${repoDir}|git:fetch --quiet origin +main:refs/remotes/origin/main`,
      `${repoDir}|git:checkout main`,
      `${repoDir}|git:merge origin/main`,
      `${repoDir}|git:rev-parse -q --verify MERGE_HEAD`,
      `${repoDir}|git:stash push --include-untracked`,
      `${repoDir}|git:checkout main`,
    ]);
  });
});
