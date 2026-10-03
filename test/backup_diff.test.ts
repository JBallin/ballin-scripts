const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { spawnSync } = require('child_process');
const { compareRepositoryRevision, RepositoryError } = require('../commands/backup_repository.ts');
const { parseDiffArguments, escapeDiffOutput, diffSummary, renderSnapshotDiff, runBackupDiff } = require('../commands/backup_diff.ts');
const { diffLimits, DiffError, createDiffBudget, checkDiffDeadline, runDiffCommand } = require('../commands/backup_diff_limits.ts');
const { fixtureDestination, fixtureState, commitFixture, requestFixture, installRepositoryFixture } = require('./helpers/repository.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { runCommand } = require('../commands/commandHelpers.ts');
import type { FixtureState } from './helpers/repository.ts';
import type { RepositoryOptions, HistoricalComparison } from '../commands/backup_repository.ts';
import type { DiffRunner, DiffBudget } from '../commands/backup_diff_limits.ts';

describe('saved backup revision inspection', function() {
  this.timeout(10000);
  let state: FixtureState; let options: RepositoryOptions; let root: string;
  const compare = (target = state.head, snapshot?: string, budget?: DiffBudget): HistoricalComparison => (
    compareRepositoryRevision(fixtureDestination, target, snapshot, options, budget)
  );
  const commit = (changes: Record<string, string | undefined>): string => {
    const files = { ...state.commits[state.head].files };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete files[name]; else files[name] = Buffer.from(value).toString('base64');
    }
    return commitFixture(state, files);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-diff-test-'));
    state = fixtureState({ 'zshrc.sh': 'old\n', gitconfig: '' });
    options = { env: testChildEnvironment({ PATH: '/usr/bin:/bin', TMPDIR: root }),
      runCommand: (command, args, opts) => command === 'gh' ? requestFixture(state, args, opts) : runCommand(command, args, opts) };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('parses only a full SHA and an exact canonical detail selector', () => {
    assert.deepEqual(parseDiffArguments([state.head.toUpperCase()]), { target: state.head, snapshot: undefined });
    assert.deepEqual(parseDiffArguments([state.head, '--snapshot', 'zshrc.sh']), { target: state.head, snapshot: 'zshrc.sh' });
    for (const args of [[], ['abc'], [state.head, '--snapshot'], [state.head, 'gitconfig', 'x'],
      [state.head, '--snapshot', 'README.md'], [state.head, '--snapshot', 'unknown'], [state.head, 'x']]) {
      assert.isUndefined(parseDiffArguments(args));
    }
    assert.throws(() => compare('x'), RepositoryError);
    assert.throws(() => compare(state.head, 'unknown'), RepositoryError);
  });
  it('summarizes saved-to-saved changes without fetching source blobs or disclosing arbitrary names', () => {
    const target = commit({ 'zshrc.sh': 'new\n', gitconfig: undefined, mas: '',
      'brackets_settings.json': 'retired', 'secret-unexpected-name': 'unexpected' });
    const result = compare(target);
    assert.deepEqual(result.changes, [{ name: 'gitconfig', kind: 'removed' }, { name: 'mas', kind: 'added' }, { name: 'zshrc.sh', kind: 'changed' }]);
    assert.equal(result.retired, 1); assert.equal(result.unexpected, 1);
    assert.notInclude(diffSummary(result), 'secret-unexpected-name');
    assert.notProperty(result, 'revision'); assert.notProperty(result, 'snapshots');
    assert.equal(state.requests.filter((r) => r.endpoint.includes('/git/blobs/')).length, 2);
    assert.isTrue(state.requests.every((r) => r.method === 'GET' || r.payload?.query?.startsWith('query ')));
    assert.isTrue(state.requests.every((r) => r.debug === ''));
  });
  it('supports marker-valid roots and marker-only initial snapshot baselines', () => {
    const initial = compare(); assert.isNull(initial.parent);
    assert.sameMembers(initial.changes.map((c) => c.name), ['gitconfig', 'zshrc.sh']);
    assert.include(diffSummary(initial), 'empty inventory');
    state = fixtureState(); commit({ mas: '' });
    assert.deepEqual(compare().changes, [{ name: 'mas', kind: 'added' }]);
    assert.equal(compare(state.head, 'mas').detail?.after?.length, 0);
  });
  it('compares a historical target to its immediate parent without attributing a later commit', () => {
    const target = commit({ 'zshrc.sh': 'middle\n' }); commit({ 'zshrc.sh': 'last\n' });
    const result = compare(target, 'zshrc.sh');
    assert.equal(result.target, target); assert.equal(result.detail?.before?.toString(), 'old\n');
    assert.equal(result.detail?.after?.toString(), 'middle\n');
  });
  it('preserves present empty versus absent detail and reports unchanged bytes', () => {
    commit({ gitconfig: undefined }); const removed = compare(state.head, 'gitconfig');
    assert.equal(removed.detail?.before?.length, 0); assert.isUndefined(removed.detail?.after);
    commit({}); assert.deepEqual(compare().changes, []); assert.include(diffSummary(compare()), 'No supported snapshot changes');
    assert.throws(() => compare(state.head, 'gitconfig'), DiffError, 'absent');
  });
  it('allows large-file metadata summaries while refusing oversized detail before blob transport', () => {
    commit({ 'zshrc.sh': 'x'.repeat(diffLimits.blobBytes + 1) });
    assert.equal(compare().changes[0].kind, 'changed'); state.requests = [];
    assert.throws(() => compare(state.head, 'zshrc.sh'), DiffError, 'size limit');
    assert.equal(state.requests.filter((r) => r.endpoint.includes('/git/blobs/')).length, 2);
  });
  it('refuses markerless seed parents and mismatched target/current markers', () => {
    const target = state.head; const seed = commitFixture(state, { 'README.md': Buffer.from('seed').toString('base64') }, []);
    state.head = target; state.commits[target].parents = [seed];
    assert.throws(() => compare(), RepositoryError, 'not a supported');
    commit({ '.ballin-backup.json': 'invalid' });
    assert.throws(() => compare(), RepositoryError, 'not a supported');
  });
  it('refuses merge targets, merge ancestry, and unreachable revisions', () => {
    const target = state.head; commitFixture(state, state.commits[target].files, [target, target]);
    assert.throws(() => compare(), DiffError, 'Merge revisions');
    assert.throws(() => compare(target), DiffError, 'Merge ancestry');
    state.head = target; assert.throws(() => compare('0'.repeat(40)), DiffError, 'outside');
  });
  it('refuses excessive ancestry and malformed cyclic ancestry', () => {
    const target = state.head; for (let i = 0; i <= diffLimits.hops; i++) commit({});
    assert.throws(() => compare(target), DiffError, 'ancestry limit');
    state = fixtureState(); state.commits[state.head].parents = [state.head];
    assert.throws(() => compare('0'.repeat(40)), RepositoryError, 'invalid');
    assert.throws(() => compare(), RepositoryError, 'invalid');
    state = fixtureState(); const target2 = state.head; const newer = commit({});
    state.commits[target2].parents = [newer];
    assert.throws(() => compare(target2), RepositoryError, 'invalid');
  });
  for (const fault of ['unreadable', { sha: '0'.repeat(40) }, { parents: null }, { tree: { sha: 'bad' } },
    { parents: [{ sha: '0'.repeat(40) }, { sha: '1'.repeat(40) }] }]) {
    it(`rejects bad historical commit response ${JSON.stringify(fault)}`, () => {
      const target = state.head; commit({}); state.faults.commit = fault;
      assert.throws(() => compare(target));
    });
  }
  it('rejects invalid/truncated/oversized current inventory before historical reads', () => {
    for (const tree of [{ truncated: true }, { tree: [] }, { tree: Array(diffLimits.entries + 1).fill({}) }]) {
      state.faults.tree = tree; assert.throws(() => compare());
    }
  });
  it('rechecks identity and pinned branch head at the end', () => {
    const original = options.runCommand!; let queries = 0;
    options.runCommand = (command, args, opts) => {
      if (String(opts.input).includes('BallinRepository') && ++queries === 2) commit({ mas: 'external' });
      return original(command, args, opts);
    };
    assert.throws(() => compare(), RepositoryError, 'changed during');
    queries = 0; state.faults.user = { node_id: 'U_other', login: 'other', type: 'User' };
    assert.throws(() => compare(), RepositoryError, 'does not match');
  });
  it('rejects a changed effective account at final identity revalidation', () => {
    const original = options.runCommand!; let accounts = 0;
    options.runCommand = (command, args, opts) => {
      if (args[args.indexOf('--method') + 2] === 'user' && ++accounts === 2) {
        state.faults.user = { node_id: 'U_other', login: 'other', type: 'User' };
      }
      return original(command, args, opts);
    };
    assert.throws(() => compare(), RepositoryError, 'does not match');
  });
  it('refuses malformed or failed bounded API output without disclosing response text', () => {
    for (const response of [{ status: 0, stdout: 'DUMMY_PRIVATE' }, { status: 1, stdout: '{}' },
      { status: 0, stdout: '[]' }, { status: null, error: new Error('DUMMY_PRIVATE') }]) {
      options.runCommand = () => response; assert.throws(() => compare());
    }
  });
  it('rejects unreadable/corrupt blobs and expired command budgets', () => {
    for (const blob of ['unreadable', { size: -1 }, { content: 'invalid' }]) {
      state.faults.blob = blob; assert.throws(() => compare());
    }
    delete state.faults.blob;
    assert.throws(() => compare(state.head, undefined, { deadline: 0, bytes: 0, requests: 0 }), DiffError, 'time limit');
  });
  it('uses one transport budget, SIGKILL, and capped pipes for every request', () => {
    const original = options.runCommand!;
    options.runCommand = (command, args, opts) => {
      assert.equal(opts.killSignal, 'SIGKILL'); assert.isAtMost(opts.timeout!, diffLimits.requestMs);
      assert.equal(opts.maxBuffer, diffLimits.streamBytes); assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
      return original(command, args, opts);
    };
    compare();
  });
  it('bounds actual subprocesses that ignore SIGTERM or emit oversized output', () => {
    const env = testChildEnvironment();
    const budget = createDiffBudget(); budget.deadline = performance.now() + 120;
    assert.throws(() => runDiffCommand(budget, process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { env }), DiffError);
    assert.throws(() => runDiffCommand(createDiffBudget(), process.execPath, ['-e', 'process.stdout.write("x".repeat(5000000))'], { env }), DiffError);
  });
  it('bounds a caller whose self-terminating descendant retains the output pipes', () => {
    const script = 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1000)"],{stdio:"inherit"});process.exit(0)';
    const budget = createDiffBudget(); const started = performance.now(); budget.deadline = started + 120;
    assert.throws(() => runDiffCommand(budget, process.execPath, ['-e', script], { env: testChildEnvironment() }), DiffError);
    assert.isBelow(performance.now() - started, 700, 'caller must return before the descendant lifetime');
  });
  it('counts failed stdout/stderr, aggregate output, requests, and elapsed time', () => {
    const budget = createDiffBudget();
    runDiffCommand(budget, 'stub', [], {}, () => ({ status: 1, stdout: 'out', stderr: 'err' }));
    assert.equal(budget.bytes, 6);
    budget.requests = diffLimits.requests; assert.throws(() => runDiffCommand(budget, 'stub', [], {}), DiffError, 'request limit');
    budget.requests = 0; budget.bytes = diffLimits.aggregateBytes - 1;
    assert.throws(() => runDiffCommand(budget, 'stub', [], {}, () => ({ status: 0, stdout: 'xx' })), DiffError);
    const elapsed = createDiffBudget(); assert.throws(() => runDiffCommand(elapsed, 'stub', [], {}, () => {
      elapsed.deadline = 0; return { status: 0 };
    }), DiffError, 'time limit');
    assert.throws(() => checkDiffDeadline({ deadline: 0 }), DiffError);
  });

  it('renders exact CRLF/text and missing newline while escaping controls and literal escapes distinctly', () => {
    const before = Buffer.from('old\r\n\\u{1b}\n'); const after = Buffer.from('new\r\n\u001b\u202e\u200d\u0085\u2028\tend');
    const output = renderSnapshotDiff({ name: 'zshrc.sh', before, after }, createDiffBudget(), options.env);
    assert.include(output, 'u{d}'); assert.include(output, '\\\\u{1b}'); assert.include(output, '\\u{202e}');
    assert.include(output, 'No newline at end of file');
    assert.notMatch(output, /[\u001b\u202e\u200d\u0085\u2028\r]/u);
    assert.notEqual(escapeDiffOutput('\\u{1b}'), escapeDiffOutput('\u001b'));
    assert.equal(escapeDiffOutput('\n\t'), '\n\t');
    assert.deepEqual(fs.readdirSync(root).filter((name: string) => name.startsWith('ballin-saved-diff-')), []);
  });
  it('renders empty-versus-absent detail and accepts Git difference exit 1', () => {
    const output = renderSnapshotDiff({ name: 'mas', after: Buffer.alloc(0) }, createDiffBudget(), options.env);
    assert.include(output, 'absent -> present (0 bytes)'); assert.include(output, 'No text differences');
  });
  it('isolates Git configuration and renders only after strict text qualification', () => {
    const runner: DiffRunner = (_command, args, opts) => {
      assert.include(args, '--no-ext-diff'); assert.include(args, '--no-textconv');
      assert.notProperty(opts.env, 'GIT_EXTERNAL_DIFF'); assert.notProperty(opts.env, 'GIT_CONFIG_COUNT');
      assert.equal(opts.env!.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(fs.statSync(path.join(opts.cwd as string, 'before')).mode & 0o777, 0o600);
      return { status: 1, stdout: '-old\n+new\n' };
    };
    renderSnapshotDiff({ name: 'mas', before: Buffer.from('old'), after: Buffer.from('new') }, createDiffBudget(),
      { ...options.env, GIT_EXTERNAL_DIFF: 'unsafe', GIT_CONFIG_COUNT: '1' }, runner);
    for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.alloc(diffLimits.blobBytes + 1)]) {
      assert.throws(() => renderSnapshotDiff({ name: 'mas', after: bytes }, createDiffBudget(), options.env), DiffError);
    }
  });
  it('ignores inherited global attributes that would suppress valid text details', () => {
    const xdg = path.join(root, 'xdg'); fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'git', 'attributes'), '* -diff\n');
    const output = renderSnapshotDiff({ name: 'mas', before: Buffer.from('old\n'), after: Buffer.from('new\n') },
      createDiffBudget(), { ...options.env, XDG_CONFIG_HOME: xdg });
    assert.include(output, '-old'); assert.include(output, '+new'); assert.notInclude(output, 'Binary files');
  });
  it('refuses render errors, post-escape oversized output and cleanup failure', () => {
    const detail = { name: 'mas', before: Buffer.from('a'), after: Buffer.from('b') };
    assert.throws(() => renderSnapshotDiff(detail, createDiffBudget(), options.env, () => ({ status: 7 })), DiffError, 'Unable');
    assert.throws(() => renderSnapshotDiff(detail, createDiffBudget(), options.env, () => ({ status: 1, stdout: '\u001b'.repeat(200000) })), DiffError, 'output limit');
    const remove = fs.rmSync; let directory = '';
    fs.rmSync = (entry: string) => { directory = entry; throw new Error('secret cleanup'); };
    try { assert.throws(() => renderSnapshotDiff(detail, createDiffBudget(), options.env), DiffError, 'cleanup'); }
    finally { fs.rmSync = remove; remove(directory, { recursive: true, force: true }); }
  });

  it('integrates CLI summary/detail and leaves configuration/cache/local sources unchanged', () => {
    const target = commit({ 'zshrc.sh': 'new\n' }); const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const config = path.join(root, 'config.json'); const statePath = path.join(root, 'state.json');
    fs.writeFileSync(config, JSON.stringify({ backup: { repository: fixtureDestination, includeSensitive: 'false' } }));
    fs.writeFileSync(statePath, JSON.stringify(state)); installRepositoryFixture(bin, statePath);
    fs.symlinkSync('/usr/bin/git', path.join(bin, 'git'));
    const source = path.join(root, '.zshrc'); fs.writeFileSync(source, 'DUMMY_LOCAL_SOURCE');
    const configBefore = fs.readFileSync(config); const contents = fs.readFileSync(source);
    const run = (args: string[]) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'ballin'), 'backup', 'diff', ...args], {
      env: testChildEnvironment({ HOME: root, PATH: bin, TMPDIR: root, BALLIN_TEST_CONFIG_PATH: config }), encoding: 'utf8',
    });
    const summary = run([target]); assert.equal(summary.status, 0, summary.stderr); assert.include(summary.stdout, 'changed zshrc.sh');
    assert.notInclude(summary.stdout, 'new\n');
    const detail = run([target, '--snapshot', 'zshrc.sh']); assert.equal(detail.status, 0, detail.stderr); assert.include(detail.stdout, '+new');
    assert.equal(run(['short']).status, 2); assert.equal(run([target, '--snapshot', 'mas']).status, 1);
    const remote: FixtureState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(remote.commits, state.commits); assert.equal(remote.head, target);
    assert.isTrue(fs.readFileSync(config).equals(configBefore)); assert.isTrue(fs.readFileSync(source).equals(contents));
    assert.isFalse(fs.existsSync(path.join(root, '.ballin', 'backups')));
  });
  it('reports read/render failures without content or misleading partial success', () => {
    const originalOut = process.stdout.write; const originalErr = process.stderr.write;
    let output = ''; let error = '';
    process.stdout.write = ((text: string) => { output += text; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((text: string) => { error += text; return true; }) as typeof process.stderr.write;
    try {
      assert.equal(runBackupDiff(fixtureDestination, { target: state.head }, options), 0); assert.include(output, 'Saved revision');
      output = ''; state.faults.auth = true;
      assert.equal(runBackupDiff(fixtureDestination, { target: state.head }, options), 1); assert.equal(output, ''); assert.include(error, 'authentication');
      delete state.faults.auth; options.runCommand = () => { throw new Error('DUMMY_PRIVATE'); }; error = '';
      assert.equal(runBackupDiff(fixtureDestination, { target: state.head }, options), 1); assert.notInclude(error, 'DUMMY_PRIVATE');
      options.runCommand = () => { throw new DiffError('controlled failure'); };
      assert.equal(runBackupDiff(fixtureDestination, { target: state.head }, options), 1); assert.include(error, 'controlled failure');
    } finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
  });
});
