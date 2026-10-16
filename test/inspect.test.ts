const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('standalone read-only inspection helper', () => {
  let root: string; let home: string; let checkout: string; let bin: string; let log: string;
  const helper = path.join(__dirname, 'inspect.ts');
  const sha = 'a'.repeat(40);
  const config = () => ({
    backup: { repository: { id: 'R_fixture', ownerId: 'U_fixture', name: 'fixture-backup', branch: 'main' }, includeSensitive: 'true', token: 'DUMMY_PRIVATE_SECRET' },
    update: { backup: 'false' }, credential: 'DUMMY_PRIVATE_SECRET',
  });
  const save = (value: unknown): void => fs.writeFileSync(path.join(checkout, 'ballin.config.json'), JSON.stringify(value));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-inspect-'));
    home = path.join(root, 'home'); checkout = path.join(home, '.ballin-scripts'); bin = path.join(root, 'bin'); log = path.join(root, 'calls');
    fs.mkdirSync(checkout, { recursive: true }); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(checkout, '.git')); fs.writeFileSync(path.join(checkout, '.git', 'index'), 'original-index');
    fs.writeFileSync(path.join(home, 'credential-marker'), 'DUMMY_PRIVATE_SECRET');
    save(config());
    const fixture = path.join(root, 'tools.cjs');
    fs.writeFileSync(fixture, `const fs=require('fs'); const path=require('path');
      const inputs=JSON.parse(fs.readFileSync(path.join(__dirname,'inputs.json'),'utf8'));
      const [tool,...args]=process.argv.slice(2); const name=path.basename(tool);
      fs.appendFileSync(path.join(__dirname,'calls'), JSON.stringify({name,args,locks:process.env.GIT_OPTIONAL_LOCKS})+'\\n');
      if(inputs.fail==='1'){process.stdout.write('DUMMY_PRIVATE_SECRET');process.stderr.write('DUMMY_PRIVATE_SECRET');process.exit(1);}
      if(name==='git' && args.join(' ')==='--version') process.stdout.write('git version 2.50.1 (Apple Git-155)\\n');
      else if(name==='npm' && args.join(' ')==='--version') process.stdout.write('11.19.0\\n');
      else if(name==='gh' && args.join(' ')==='--version') process.stdout.write('gh version 2.80.0 (2025-01-01)\\nhttps://example.invalid\\n');
      else if(name==='sw_vers' && args.join(' ')==='-productVersion') process.stdout.write('26.0.1\\n');
      else if(name==='git' && args.slice(0,6).join(' ')==='--no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -C' && args[6]===inputs.checkout && process.env.GIT_OPTIONAL_LOCKS==='0') {
        if(args.slice(7).join(' ')==='rev-parse --show-toplevel') process.stdout.write(inputs.checkout+'\\n');
        else if(args.slice(7).join(' ')==='config --null --name-only --list --includes') process.stdout.write('core.bare\\0');
        else if(args.slice(7).join(' ')==='rev-parse --verify HEAD') process.stdout.write('a'.repeat(40)+'\\n');
        else if(args.slice(7).join(' ')==='status --porcelain=v1 --untracked-files=normal --ignore-submodules=all') process.stdout.write(inputs.dirty==='1'?'?? DUMMY_PRIVATE_SECRET\\n':'');
        else process.exit(99);
      } else process.exit(99);`);
    for (const name of ['git', 'npm', 'gh', 'sw_vers']) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\ntask_bin=${0%/*}\nexec "$task_bin/node" "$task_bin/tools.cjs" "$0" "$@"\n', { mode: 0o755 });
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.symlinkSync(fixture, path.join(bin, 'tools.cjs'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (env: NodeJS.ProcessEnv = {}, args = ['fixture-backup']) => {
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({checkout, fail: env.INSPECT_TEST_FAIL, dirty: env.INSPECT_TEST_DIRTY}));
    const before: [string, string][] = fs.readdirSync(checkout, { recursive: true }).filter((name: string) => fs.statSync(path.join(checkout, name)).isFile())
      .map((name: string) => [name, fs.readFileSync(path.join(checkout, name), 'base64')]);
    const result = spawnSync(process.execPath, [helper, ...args], {
      encoding: 'utf8', timeout: 10000, env: testChildEnvironment({
        HOME: home, PATH: bin, TMPDIR: root,
        ...env,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.notInclude(result.stdout, 'DUMMY_PRIVATE_SECRET');
    assert.notInclude(result.stdout, 'R_fixture'); assert.notInclude(result.stdout, 'U_fixture');
    for (const [name, bytes] of before) assert.equal(fs.readFileSync(path.join(checkout, name), 'base64'), bytes);
    assert.deepEqual(fs.readdirSync(checkout, { recursive: true }).filter((name: string) => fs.statSync(path.join(checkout, name)).isFile()).sort(), before.map(([name]) => name).sort());
    assert.equal(fs.readFileSync(path.join(home, 'credential-marker'), 'utf8'), 'DUMMY_PRIVATE_SECRET');
    return JSON.parse(result.stdout);
  };
  it('reports versions, commit, clean state and only selected linkage flags', () => {
    const report = run();
    assert.deepEqual(report.runtime, { platform: process.platform, arch: process.arch, macOS: process.platform === 'darwin' ? '26.0.1' : null, node: process.versions.node, npm: '11.19.0', git: '2.50.1', gh: '2.80.0' });
    assert.equal(report.installedCommit, sha); assert.equal(report.workingTree, 'clean'); assert.isNull(report.workingTreeReason);
    assert.deepEqual(report.backup, { state: 'read', linkagePresent: true, nameMatchesExpected: true, repositoryIdPresent: true, ownerIdPresent: true, branchIsMain: true, legacyGistPresent: false, includeSensitive: 'true', automaticBackup: 'false' });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
    assert.isTrue(calls.filter(({ name }: { name: string }) => name === 'git').every(({ locks }: { locks: string }) => locks === '0'));
    assert.isFalse(calls.some(({ args }: { args: string[] }) => args.includes('api') || args.includes('fetch') || args.includes('setup') || args.includes('backup')));
  });
  it('reports dirty state without filenames and compares the expected name', () => {
    const report = run({ INSPECT_TEST_DIRTY: '1' }, ['other-backup', checkout]);
    assert.equal(report.workingTree, 'dirty'); assert.isFalse(report.backup.nameMatchesExpected);
    assert.equal(run({}, []).backup.nameMatchesExpected, null);
  });
  it('keeps raw child failures private and reports unavailable fields', () => {
    const report = run({ INSPECT_TEST_FAIL: '1' });
    assert.equal(report.installedCommit, 'unavailable'); assert.equal(report.workingTree, 'unavailable');
    assert.equal(report.workingTreeReason, 'checkout-unavailable');
    for (const name of ['git', 'npm', 'gh']) assert.equal(report.runtime[name], 'unavailable');
  });
  it('does not expose malformed or unselected configuration contents', () => {
    fs.writeFileSync(path.join(checkout, 'ballin.config.json'), '{"token":"DUMMY_PRIVATE_SECRET"');
    assert.deepEqual(run().backup, { state: 'unreadable' });
    save([]); assert.deepEqual(run().backup, { state: 'invalid' });
    save({ backup: { includeSensitive: 'DUMMY_PRIVATE_SECRET' }, update: {} });
    const report = run();
    assert.isFalse(report.backup.linkagePresent); assert.equal(report.backup.includeSensitive, 'invalid'); assert.equal(report.backup.automaticBackup, 'unset');
  });
  it('does not follow a replaced config symlink or create a missing config', () => {
    fs.unlinkSync(path.join(checkout, 'ballin.config.json'));
    assert.deepEqual(run().backup, { state: 'missing' });
    fs.symlinkSync(path.join(home, 'credential-marker'), path.join(checkout, 'ballin.config.json'));
    assert.deepEqual(run().backup, { state: 'unreadable' });
  });
});

describe('inspection with real Git', () => {
  const helper = path.join(__dirname, 'inspect.ts');
  let root: string; let home: string; let checkout: string; let bin: string; let env: NodeJS.ProcessEnv;
  const git = (args: string[], directory = checkout, extra: NodeJS.ProcessEnv = {}): string => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const initialize = (directory: string): string => {
    fs.mkdirSync(directory, { recursive: true });
    git(['init', '--quiet'], directory);
    fs.writeFileSync(path.join(directory, 'tracked'), 'original\n');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'ballin.config.json\n');
    git(['add', '.'], directory);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', path.basename(directory)], directory);
    return git(['rev-parse', 'HEAD'], directory);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-inspect-git-'));
    home = path.join(root, 'home'); checkout = path.join(root, 'selected'); bin = path.join(root, 'bin');
    fs.mkdirSync(home); fs.mkdirSync(bin);
    // Use the installed Git implementation with fixture-owned system config.
    // The helper deliberately removes inherited GIT_CONFIG_NOSYSTEM, so setting
    // that in the child environment alone cannot isolate a runner's system filters.
    const lookup = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: process.env.PATH }),
    });
    assert.equal(lookup.status, 0, lookup.stderr);
    assert.isTrue(path.isAbsolute(lookup.stdout.trim()));
    fs.writeFileSync(path.join(bin, 'real-git-path'), lookup.stdout.trim() + '\n');
    fs.writeFileSync(path.join(bin, 'system.config'), '');
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ntask_bin=${0%/*}\nIFS= read -r task_git < "$task_bin/real-git-path"\nGIT_CONFIG_SYSTEM="$task_bin/system.config" GIT_CONFIG_NOSYSTEM=0 exec "$task_git" "$@"\n', { mode: 0o755 });
    // Other tools only report fixture versions; their real implementations are not run.
    for (const [name, output] of [['npm', '11.19.0'], ['gh', 'gh version 2.80.0'], ['sw_vers', '26.0.1']]) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    }
    env = testChildEnvironment({ HOME: home, XDG_CONFIG_HOME: home, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1' });
    initialize(checkout);
    fs.writeFileSync(path.join(checkout, 'ballin.config.json'), JSON.stringify({ backup: { includeSensitive: false }, credential: 'DUMMY_PRIVATE_SECRET' }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (hostile: NodeJS.ProcessEnv = {}, directory = checkout) => {
    const index = path.join(checkout, '.git', 'index'); const before = fs.readFileSync(index);
    const result = spawnSync(process.execPath, [helper, 'fixture-backup', directory], { env: { ...env, ...hostile }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.notInclude(result.stdout, 'DUMMY_PRIVATE_SECRET');
    assert.deepEqual(fs.readFileSync(index), before, 'inspection must preserve the real index byte for byte');
    assert.isFalse(fs.existsSync(index + '.lock'));
    return JSON.parse(result.stdout);
  };
  it('inspects the selected checkout despite inherited repository, index and config overrides', () => {
    const expected = git(['rev-parse', 'HEAD']);
    const other = path.join(root, 'other'); const otherHead = initialize(other);
    assert.notEqual(expected, otherHead);
    fs.writeFileSync(path.join(checkout, 'tracked'), 'DUMMY_PRIVATE_SECRET\n');
    const otherIndex = fs.readFileSync(path.join(other, '.git', 'index'));
    const hostile = {
      GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: path.join(other, '.git'),
      GIT_INDEX_FILE: path.join(other, '.git', 'index'), GIT_OBJECT_DIRECTORY: path.join(other, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(other, '.git', 'objects'), GIT_NAMESPACE: 'unrelated',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_PARAMETERS: "'core.worktree=/not-the-selected-checkout'", GIT_CEILING_DIRECTORIES: root,
    };
    // Positive control: ordinary Git is redirected by these inherited variables.
    assert.equal(git(['rev-parse', 'HEAD'], checkout, hostile), otherHead);
    const report = run(hostile);
    assert.equal(report.installedCommit, expected); assert.isNull(report.workingTreeReason, JSON.stringify(report)); assert.equal(report.workingTree, 'dirty');
    assert.deepEqual(fs.readFileSync(path.join(other, '.git', 'index')), otherIndex);
    assert.isFalse(report.backup.includeSensitive === 'true');
  });
  it('creates no inherited or configured trace files, including during git --version', () => {
    const expected = git(['rev-parse', 'HEAD']);
    const control = path.join(root, 'control.trace');
    git(['--version'], checkout, { GIT_TRACE: control }); assert.isTrue(fs.existsSync(control));
    const hostile = Object.fromEntries(['GIT_TRACE', 'GIT_TRACE_SETUP', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_PACKET', 'GIT_TRACE_CURL', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']
      .map((key) => [key, path.join(root, key + '.trace')]));
    // Trace2 targets can be configured globally without any GIT_* variable.
    for (const key of ['normalTarget', 'eventTarget', 'perfTarget']) git(['config', '--global', 'trace2.' + key, path.join(root, key + '.trace')]);
    const snapshot = () => fs.readdirSync(root).sort().map((name: string) => [name, fs.statSync(path.join(root, name)).isFile() ? fs.readFileSync(path.join(root, name), 'base64') : null]);
    const before = snapshot();
    const report = run(hostile);
    assert.isNull(report.workingTreeReason, JSON.stringify(report)); assert.equal(report.workingTree, 'clean'); assert.equal(report.installedCommit, expected);
    // Do not invoke another ordinary Git after the guarded operation when checking traces.
    assert.deepEqual(snapshot(), before);
  });
  for (const [kind, scope] of [['clean', 'global'], ['process', 'local'], ['clean', 'system']]) {
    it(`declines status with a marker-producing ${scope} ${kind} filter and preserves the index`, () => {
      fs.writeFileSync(path.join(checkout, '.gitattributes'), 'tracked filter=fixture\n');
      const marker = path.join(root, kind + '.marker');
      const filter = kind === 'clean' ? 'printf x > ../clean.marker; cat' : 'printf x > ../process.marker; exit 1';
      // Cover included global, repository-local, and system filter definitions.
      if (scope === 'global') {
        const included = path.join(home, 'included.config');
        git(['config', '--file', included, 'filter.fixture.clean', filter]);
        git(['config', '--global', 'include.path', included]);
      } else if (scope === 'system') git(['config', '--file', path.join(bin, 'system.config'), 'filter.fixture.clean', filter]);
      else git(['config', 'filter.fixture.process', filter]);
      fs.writeFileSync(path.join(checkout, 'tracked'), 'modified\n');
      const report = run();
      assert.match(report.installedCommit, /^[a-f0-9]{40}$/u);
      assert.equal(report.workingTree, 'unavailable'); assert.equal(report.workingTreeReason, 'filters-configured');
      assert.isFalse(fs.existsSync(marker), 'helper must never invoke the filter');
      // Positive control after the inspection: normal status really runs this filter.
      const index = fs.readFileSync(path.join(checkout, '.git', 'index'));
      spawnSync('git', ['--no-optional-locks', '-C', checkout, 'status', '--porcelain'], { env, encoding: 'utf8' });
      assert.isTrue(fs.existsSync(marker), 'fixture must exercise real filter execution');
      assert.deepEqual(fs.readFileSync(path.join(checkout, '.git', 'index')), index);
    });
  }
  it('does not fall back to a parent checkout or a configured different worktree', () => {
    const nested = path.join(checkout, 'nested'); fs.mkdirSync(nested);
    assert.equal(run({}, nested).workingTreeReason, 'checkout-unavailable');
    git(['config', 'core.worktree', path.join(root, 'other-worktree')]);
    fs.mkdirSync(path.join(root, 'other-worktree'));
    const report = run();
    assert.equal(report.installedCommit, 'unavailable'); assert.equal(report.workingTree, 'unavailable');
    assert.equal(report.workingTreeReason, 'checkout-unavailable');
  });
  it('reports configuration failures without claiming a clean checkout or exposing errors', () => {
    fs.appendFileSync(path.join(home, '.gitconfig'), '[DUMMY_PRIVATE_SECRET invalid config\n');
    const report = run();
    assert.equal(report.workingTree, 'unavailable'); assert.isNotNull(report.workingTreeReason);
  });
});
