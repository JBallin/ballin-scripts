const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { fixtureDestination, fixtureState, installRepositoryFixture, blobHash } = require('./helpers/repository.ts');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');
import type { FixtureState } from './helpers/repository.ts';

const repoRoot = path.join(__dirname, '..');
describe('saved backup discovery', function() {
  this.timeout(15000);
  let root: string; let home: string; let bin: string; let checkout: string;
  let configPath: string; let statePath: string; let tmp: string;
  const state = (): FixtureState => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const save = (value: FixtureState): void => fs.writeFileSync(statePath, JSON.stringify(value));
  const run = (args = ['list'], env: NodeJS.ProcessEnv = {}, preload = '') => {
    const preloadPath = path.join(root, 'preload.cjs');
    fs.writeFileSync(preloadPath, preload);
    return spawnSync(process.execPath, ['--require', preloadPath, path.join(repoRoot, 'bin', 'ballin'), 'backup', ...args], {
      encoding: 'utf8', cwd: checkout, env: testChildEnvironment({
        HOME: home, PATH: bin, TMPDIR: tmp,
        BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout, ...env,
      }),
    });
  };
  const preserved = (): void => {
    assert.equal(fs.readFileSync(configPath, 'utf8'), JSON.stringify({
      backup: { repository: fixtureDestination, includeSensitive: 'false' }, analytics: { enabled: 'false' },
    }));
    for (const file of ['.backup-cache/base', '.backup-status', '.gitconfig', '.config/gh/hosts.yml']) {
      assert.equal(fs.readFileSync(path.join(home, file), 'utf8'), 'protected\n');
      assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600);
    }
    assert.isTrue(fs.lstatSync(path.join(checkout, '.backup-cache')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.isFalse(fs.existsSync(path.join(root, 'collector.log')));
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    assert.isFalse(fs.existsSync(path.join(checkout, '.analytics')));
    assert.isTrue(state().requests.every((request) => request.endpoint !== 'open'
      && (request.method === 'GET' || (request.endpoint === 'graphql' && request.payload?.query?.includes('query BallinRepository')))));
  };
  const expectFailure = (result: ReturnType<typeof run>, message: string): void => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, message);
    assert.notInclude(result.stderr, 'dummy-secret');
    assert.notInclude(result.stderr, 'No current snapshots');
    assert.notInclude(result.stderr, 'no supported snapshot found');
    preserved();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-list-test-'));
    home = path.join(root, 'home'); bin = path.join(root, 'bin'); checkout = path.join(root, 'checkout'); tmp = path.join(root, 'tmp');
    for (const dir of [home, bin, checkout, tmp]) fs.mkdirSync(dir);
    configPath = path.join(checkout, 'ballin.config.json'); statePath = path.join(root, 'repository.json');
    fs.writeFileSync(configPath, JSON.stringify({
      backup: { repository: fixtureDestination, includeSensitive: 'false' }, analytics: { enabled: 'false' },
    }));
    for (const file of ['.backup-cache/base', '.backup-status', '.gitconfig', '.config/gh/hosts.yml']) {
      const target = path.join(home, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'protected\n', { mode: 0o600 });
    }
    fs.symlinkSync(path.join(home, '.backup-cache'), path.join(checkout, '.backup-cache'));
    for (const command of ['brew', 'npm', 'pipx', 'pyenv', 'uv', 'mas', 'code', 'git', 'cat', 'open']) {
      fs.writeFileSync(path.join(bin, command), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(path.join(root, 'collector.log'))}, ${JSON.stringify(command)}); process.exit(99);\n`, { mode: 0o755 });
    }
    save(fixtureState()); installRepositoryFixture(bin, statePath);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists only saved canonical selectors despite absent local sources and excluded future capture', () => {
    save(fixtureState({ 'zshrc.sh': 'saved private bytes\n', Brewfile: 'brew\n', brew_list: 'tools\n', vs_settings: '{}\n' }));
    const before = state(); const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Saved snapshots:\n  Brewfile\n  brew_list\n  vs_settings\n  zshrc.sh\nRead a snapshot with `ballin backup read <snapshot>`.\n');
    assert.equal(result.stderr, '');
    assert.notInclude(result.stdout, 'saved private bytes');
    const after = state();
    assert.deepEqual({ ...after, requests: [] }, { ...before, requests: [] });
    assert.lengthOf(after.requests, 6);
    assert.lengthOf(after.requests.filter((request) => request.endpoint.includes('/git/blobs/')), 1);
    preserved();
  });
  for (const { provider, primary, secondary, missing } of [
    { provider: 'Codex', primary: 'codex_config.toml', secondary: 'codex_skills.bundle.json', missing: 'codex_rules.bundle.json' },
    { provider: 'Claude Code', primary: 'claude_agents.bundle.json', secondary: 'claude_instructions', missing: 'claude_commands.bundle.json' },
  ]) {
    it(`discovers and reads saved ${provider} snapshots with future sensitive capture disabled`, () => {
      const bytes = 'synthetic = true\r\n\n';
      save(fixtureState({ [primary]: bytes, [secondary]: '{"synthetic":true}\n' }));
      const options = `Saved snapshots:\n  ${primary}\n  ${secondary}\nRead a snapshot with \`ballin backup read <snapshot>\`.\nList files in a bundle with \`ballin backup read <bundle> --list\`.\n`;
      for (const args of [['list'], ['read'], ['read', missing]]) {
        const before = state(); before.requests = []; save(before);
        const result = run(args);
        assert.equal(result.status, args[0] === 'list' ? 0 : 1, result.stderr);
        assert.equal(result.stdout, options);
        const after = state();
        assert.deepEqual({ ...after, requests: [] }, { ...before, requests: [] });
        assert.lengthOf(after.requests, 6);
        assert.lengthOf(after.requests.filter((request) => request.endpoint.includes('/git/blobs/')), 1);
        assert.isFalse(fs.existsSync(path.join(home, '.codex')));
        assert.isFalse(fs.existsSync(path.join(home, '.claude')));
        preserved();
      }
      const before = state(); before.requests = []; save(before);
      const result = run(['read', primary]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, bytes);
      assert.equal(result.stderr, '');
      assert.lengthOf(state().requests, 7);
      assert.lengthOf(state().requests.filter((request) => request.endpoint.includes('/git/blobs/')), 2);
      preserved();
    });
  }
  for (const readme of [true, false]) {
    it(`reports a valid marker-only inventory with README ${readme ? 'present' : 'absent'}`, () => {
      const value = state(); if (!readme) delete value.commits[value.head].files['README.md']; save(value);
      const result = run(); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'No current snapshots are saved in this backup.\n'); preserved();
    });
  }
  for (const snapshot of ['codex_skills.bundle.json', 'codex_user_skills.bundle.json', 'codex_rules.bundle.json', 'claude_rules.bundle.json', 'claude_agents.bundle.json', 'claude_commands.bundle.json']) {
    it(`lists and decodes saved ${snapshot} members without capture or writes`, () => {
      const content = '# Synthetic example\r\nlast';
      const member = { path: 'example/SKILL.md', executable: true, content: Buffer.from(content).toString('base64') };
      const archive = `${JSON.stringify({ format: 'ballin-directory', version: 1, entries: [member] }, null, 2)}\n`;
      save(fixtureState({ [snapshot]: archive })); const before = state();
      const listed = run(['read', snapshot, '--list']);
      assert.equal(listed.status, 0, listed.stderr); assert.equal(listed.stderr, '');
      assert.deepEqual(JSON.parse(listed.stdout), [{ path: member.path, executable: true, bytes: Buffer.byteLength(content) }]);
      assert.notInclude(listed.stdout, 'Synthetic example');
      const read = run(['read', snapshot, '--file', member.path]);
      assert.equal(read.status, 0, read.stderr); assert.equal(read.stderr, ''); assert.equal(read.stdout, content);
      assert.equal(run(['read', snapshot]).stdout, archive);
      assert.deepEqual({ ...state(), requests: [] }, { ...before, requests: [] }); preserved();
    });
  }
  it('writes exact binary and empty member bytes to stdout with no framing', () => {
    for (const bytes of [Buffer.from([0, 255, 128, 13, 10]), Buffer.alloc(0)]) {
      save(fixtureState({ 'codex_skills.bundle.json': JSON.stringify({ format: 'ballin-directory', version: 1, entries: [
        { path: 'binary', executable: false, content: bytes.toString('base64') },
      ] }) }));
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), 'backup', 'read', 'codex_skills.bundle.json', '--file', 'binary'], {
        cwd: checkout, env: testChildEnvironment({ HOME: home, PATH: bin, TMPDIR: tmp, BALLIN_TEST_CONFIG_PATH: configPath, BALLIN_TEST_REPO_DIR: checkout }),
      });
      assert.equal(result.status, 0, result.stderr.toString()); assert.deepEqual(result.stdout, bytes); preserved();
    }
  });
  it('stages interactive bundle hints while preserving exact raw, JSON and member stdout', () => {
    const archive = JSON.stringify({ format: 'ballin-directory', version: 2, entries: [
      { path: 'rule.md', executable: false, encoding: 'utf8', content: ['synthetic\r\n', 'last'] },
    ] });
    save(fixtureState({ 'codex_rules.bundle.json': archive }));
    const tty = "for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', {value:true});";
    const raw = run(['read', 'codex_rules.bundle.json'], {}, tty);
    assert.equal(raw.status, 0, raw.stderr); assert.equal(raw.stdout, archive);
    assert.include(raw.stderr, 'backup read <bundle> --list'); assert.notInclude(raw.stderr, '--file');
    const listed = run(['read', 'codex_rules.bundle.json', '--list'], {}, tty);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), [{ path: 'rule.md', executable: false, bytes: 15 }]);
    assert.include(listed.stderr, 'backup read <bundle> --file <path>');
    const member = run(['read', 'codex_rules.bundle.json', '--file', 'rule.md'], {}, tty);
    assert.equal(member.status, 0, member.stderr); assert.equal(member.stdout, 'synthetic\r\nlast'); assert.equal(member.stderr, '');
    preserved();
  });
  it('keeps redirected streams, ordinary snapshots, malformed raw archives and errors free of hints', () => {
    const archive = JSON.stringify({ format: 'ballin-directory', version: 1, entries: [
      { path: 'rule.md', executable: false, content: 'YQ==' },
    ] });
    for (const redirected of ['stdin', 'stdout', 'stderr']) {
      const tty = `for (const stream of ['stdin','stdout','stderr']) Object.defineProperty(process[stream], 'isTTY', {value:stream!==${JSON.stringify(redirected)}});`;
      save(fixtureState({ 'codex_rules.bundle.json': archive }));
      for (const options of [[], ['--list']]) {
        const result = run(['read', 'codex_rules.bundle.json', ...options], {}, tty);
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
      }
    }
    const tty = "for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', {value:true});";
    for (const [name, content] of [['gitconfig', archive], ['codex_rules.bundle.json', 'malformed raw archive']]) {
      save(fixtureState({ [name]: content }));
      const result = run(['read', name], {}, tty); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, content); assert.equal(result.stderr, '');
    }
    const invalid = run(['read', 'codex_rules.bundle.json', '--list'], {}, tty);
    expectFailure(invalid, 'not a supported directory snapshot'); assert.notInclude(invalid.stderr, 'Read saved files');
    preserved();
  });
  it('lists actual bundle selectors without blob reads, aliases, filters or member payloads', () => {
    save(fixtureState({ 'codex_rules.bundle.json': 'unreadable as an archive', 'codex_rules.json': 'old bytes', gitconfig: 'plain' }));
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, '  codex_rules.bundle.json\n'); assert.include(result.stdout, '  gitconfig\n');
    assert.include(result.stdout, 'Retired snapshots:\n  codex_rules.json\n');
    assert.include(result.stdout, 'backup read <bundle> --list'); assert.notInclude(result.stdout, '--file');
    assert.lengthOf(state().requests.filter((request) => request.endpoint.includes('/git/blobs/')), 1);
    const old = run(['read', 'codex_rules.json']); assert.equal(old.status, 1);
    assert.include(old.stderr, 'no supported snapshot found'); assert.notInclude(old.stdout, 'old bytes');
    preserved();
  });
  it('lists and reads readable version-2 members without altering stored archive bytes', () => {
    const content = '\ufeff# Synthetic\r\nlast';
    const archive = `${JSON.stringify({ format: 'ballin-directory', version: 2, entries: [
      { path: 'rule.md', executable: false, encoding: 'utf8', content: ['\ufeff# Synthetic\r\n', 'last'] },
      { path: 'empty.md', executable: false, encoding: 'base64', content: '' },
    ] }, null, 2)}\n`;
    save(fixtureState({ 'claude_rules.bundle.json': archive }));
    const listed = run(['read', 'claude_rules.bundle.json', '--list']); assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), [
      { path: 'rule.md', executable: false, bytes: Buffer.byteLength(content) }, { path: 'empty.md', executable: false, bytes: 0 },
    ]);
    const read = run(['read', 'claude_rules.bundle.json', '--file', 'rule.md']); assert.equal(read.status, 0, read.stderr); assert.equal(read.stdout, content);
    const empty = run(['read', 'claude_rules.bundle.json', '--file', 'empty.md']); assert.equal(empty.status, 0, empty.stderr); assert.equal(empty.stdout, '');
    assert.equal(run(['read', 'claude_rules.bundle.json']).stdout, archive); preserved();
  });
  it('rejects malformed or unsupported directory contents before any member output', () => {
    for (const archive of ['DUMMY_PRIVATE_DATA', JSON.stringify({ format: 'ballin-directory', version: 2, entries: [] }), JSON.stringify({
      format: 'ballin-directory', version: 1, entries: [
        { path: 'valid', executable: false, content: Buffer.from('DUMMY_PRIVATE_CONTENT').toString('base64') },
        { path: '../DUMMY_PRIVATE_PATH', executable: false, content: '' },
      ],
    })]) {
      save(fixtureState({ 'codex_skills.bundle.json': archive }));
      for (const option of [['--list'], ['--file', 'valid']]) {
        const result = run(['read', 'codex_skills.bundle.json', ...option]);
        expectFailure(result, 'not a supported directory snapshot'); assert.notInclude(result.stderr, 'DUMMY_PRIVATE');
      }
    }
  });
  it('reports missing members without exposing private selectors or emitting content', () => {
    save(fixtureState({ 'claude_rules.bundle.json': JSON.stringify({ format: 'ballin-directory', version: 1, entries: [{ path: 'rule.md', executable: false, content: '' }] }) }));
    const result = run(['read', 'claude_rules.bundle.json', '--file', 'DUMMY_PRIVATE_PATH']);
    expectFailure(result, 'no matching directory member'); assert.notInclude(result.stderr, 'DUMMY_PRIVATE');
  });
  it('rejects invalid directory option combinations offline before reading configuration', () => {
    fs.writeFileSync(configPath, '{broken');
    for (const args of [
      ['read', 'codex_skills.bundle.json', '--file'], ['read', 'codex_skills.bundle.json', '--file', ''],
      ['read', 'codex_skills.bundle.json', '--list', 'extra'], ['read', 'codex_skills.bundle.json', '--list', '--file', 'x'],
      ['read', '', '--list'], ['read', '--list', 'codex_skills.bundle.json'],
      ['read', '--list'], ['read', '--file'],
    ]) {
      const result = run(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.include(result.stderr, 'expected exactly one snapshot'); assert.deepEqual(state().requests, []);
    }
  });
  it('distinguishes retired entries, hides reserved entries, and counts unexpected names without disclosure', () => {
    const unknown = 'DUMMY_PRIVATE_NAME $(touch forbidden)';
    save(fixtureState({ gitconfig: 'private git\n', brackets_extensions: 'old\n', [unknown]: 'secret\n', '.MyConfig.md': 'old gist\n', 'zshrc.sh.bak': 'near match\n' }));
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Saved snapshots:\n  gitconfig\nRead a snapshot with `ballin backup read <snapshot>`.\n\nRetired snapshots:\n  brackets_extensions\nInspect retired snapshots with `ballin backup open`.\n\nUnexpected entries: 3. Inspect them with `ballin backup open`.\n');
    for (const text of [unknown, '.MyConfig.md', 'zshrc.sh.bak', 'README.md', '.ballin-backup.json', 'secret', state().id, state().head]) assert.notInclude(result.stdout + result.stderr, text);
    preserved();
  });
  it('lists retired-only storage without advertising retired content as an explicit-read selector', () => {
    save(fixtureState({ 'brackets_settings.json': '{}\n' }));
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'No current snapshots are saved');
    assert.include(result.stdout, 'Retired snapshots:\n  brackets_settings.json\n');
    assert.notInclude(result.stdout, 'backup read'); preserved();
  });
  it('lists presence without retrieving a failing canonical blob, while explicit read reports retrieval failure', () => {
    save(fixtureState({ 'zshrc.sh': 'private saved\n' }));
    const target = blobHash(Buffer.from('private saved\n').toString('base64'));
    const preload = `const spawn=require('child_process').spawnSync;
      require('child_process').spawnSync=function(command,args,options){
        if(command==='gh' && args.some(value=>String(value).endsWith('/git/blobs/${target}'))) return {status:1,stdout:'',stderr:'DUMMY_PRIVATE_API_ERROR'};
        return spawn(command,args,options);
      };`;
    const listed = run(['list'], {}, preload); assert.equal(listed.status, 0, listed.stderr);
    assert.include(listed.stdout, '  zshrc.sh\n');
    expectFailure(run(['read', 'zshrc.sh'], {}, preload), 'could not be read completely');
  });
  for (const [label, faults, message] of [
    ['authentication', { auth: true }, 'authentication is required'],
    ['inaccessible destination', { query: 'missing' }, 'missing or inaccessible'],
    ['public destination', { node: { isPrivate: false } }, 'not a supported'],
    ['wrong identity', { node: { id: 'R_other' } }, 'does not match'],
    ['unreadable tree', { tree: 'unreadable' }, 'could not be read completely'],
    ['truncated tree', { tree: { truncated: true } }, 'could not be read completely'],
    ['malformed tree', { tree: { tree: null } }, 'invalid backup metadata'],
    ['unreadable marker', { blob: 'unreadable' }, 'could not be read completely'],
  ] as const) {
    it(`fails closed for ${label}`, () => {
      const value = fixtureState({ gitconfig: 'saved\n' }); value.faults = { ...faults }; save(value);
      expectFailure(run(), message);
    });
  }
  for (const marker of [undefined, 'wrong marker\n']) {
    it(`rejects ${marker === undefined ? 'missing' : 'invalid'} marker without claiming empty storage`, () => {
      const value = state();
      if (marker === undefined) value.commits[value.head].files = {};
      else value.commits[value.head].files['.ballin-backup.json'] = Buffer.from(marker).toString('base64');
      save(value); expectFailure(run(), 'not a supported');
    });
  }
  for (const name of ['archive/gitconfig', 'DUMMY_PRIVATE_CONTROL\x1bname']) {
    it('retains unsupported layout rejection without disclosing the entry', () => {
      save(fixtureState({ [name]: 'secret\n' })); const result = run();
      expectFailure(result, 'not a supported'); assert.notInclude(result.stderr, name);
    });
  }
  it('does not use cache contents as saved inventory', () => {
    const value = state(); value.faults.tree = 'unreadable'; save(value);
    expectFailure(run(), 'could not be read completely');
  });
  for (const movement of ['head', 'account']) {
    it(`reports final ${movement} movement without emitting saved rows or retrying`, () => {
      save(fixtureState({ gitconfig: 'saved\n' }));
      const preload = `const fs=require('fs'); const helper=require(${JSON.stringify(path.join(__dirname, 'helpers', 'repository.ts'))});
        const original=require('child_process').spawnSync; let queries=0; let accounts=0;
        require('child_process').spawnSync=function(command,args,options){
          const query=command==='gh' && String(options.input).includes('query BallinRepository');
          const account=command==='gh' && args[args.indexOf('--method')+2]==='user';
          if((${JSON.stringify(movement)}==='head' && query && ++queries===2)
            || (${JSON.stringify(movement)}==='account' && account && ++accounts===2)) {
            const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
            if(${JSON.stringify(movement)}==='head') helper.commitFixture(state,state.commits[state.head].files);
            else state.faults.user={node_id:'U_other',login:'other',type:'User'};
            fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify(state));
          }
          return original(command,args,options);
        };`;
      expectFailure(run(['list'], {}, preload), movement === 'head' ? 'changed during inspection' : 'does not match');
      assert.isAtMost(state().requests.length, 6);
    });
  }
  it('fails safely when private transport creation is unavailable', () => {
    const preload = `const fs=require('fs'); const original=fs.mkdtempSync;
      fs.mkdtempSync=function(prefix,...args){ if(String(prefix).includes('ballin-repository-')) throw new Error('DUMMY_PRIVATE_IO_ERROR');
        return original.call(this,prefix,...args); };`;
    const result = run(['list'], {}, preload); expectFailure(result, 'Unable to prepare private backup transport files');
    assert.notInclude(result.stderr, 'DUMMY_PRIVATE_IO_ERROR'); assert.deepEqual(state().requests, []);
  });
  it('reports incomplete transport cleanup without claiming successful inventory', () => {
    const preload = `const fs=require('fs'); const original=fs.rmSync;
      fs.rmSync=function(target,...args){ if(String(target).includes('ballin-repository-')) {
        fs.appendFileSync(${JSON.stringify(path.join(root, 'cleanup.log'))}, String(target)+'\\n'); throw new Error('DUMMY_PRIVATE_CLEANUP_ERROR'); }
        return original.call(this,target,...args); };`;
    const result = run(['list'], {}, preload);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.include(result.stderr, 'Private temporary-file cleanup is incomplete');
    assert.notInclude(result.stderr, 'DUMMY_PRIVATE_CLEANUP_ERROR');
    const leaked = fs.readFileSync(path.join(root, 'cleanup.log'), 'utf8').trim().split('\n');
    assert.lengthOf(leaked, 1); assert.isTrue(fs.existsSync(leaked[0]));
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(leaked[0])]);
    fs.rmSync(leaked[0], { recursive: true }); preserved();
  });
  it('keeps usage and help offline with unreadable configuration', () => {
    fs.writeFileSync(configPath, '{broken');
    for (const args of [['read'], ['list', 'extra'], ['list', '--verbose'], ['--help']]) {
      const result = run(args); assert.equal(result.status, args[0] === '--help' ? 0 : 1);
      assert.include(result.stdout + result.stderr, args[0] === '--help' ? 'ballin backup list' : args[0] === 'read' ? 'expected one snapshot' : 'expected no arguments');
      assert.notInclude(result.stdout + result.stderr, 'Options:');
      assert.deepEqual(state().requests, []);
      assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken');
      assert.isFalse(fs.existsSync(path.join(root, 'collector.log')));
    }
  });
  it('rejects excess read arguments before any inventory lookup, including an empty selector', () => {
    for (const selector of ['', 'gitconfig']) {
      const result = run(['read', selector, 'extra']);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.include(result.stderr, 'expected exactly one snapshot');
      assert.deepEqual(state().requests, []); preserved();
    }
  });
  it('shows actual saved options for read without a selector while preserving the usage error', () => {
    save(fixtureState({ 'zshrc.sh': 'DUMMY_PRIVATE_CONTENT\n', gitconfig: 'private git\n', brackets_extensions: 'old\n', DUMMY_PRIVATE_NAME: 'unrelated\n' }));
    const before = state(); const result = run(['read']);
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'expected one snapshot');
    assert.include(result.stderr, 'ballin backup read <snapshot>');
    assert.notInclude(result.stdout + result.stderr, 'backup list');
    assert.equal(result.stdout, run(['list']).stdout);
    assert.include(result.stdout, 'Saved snapshots:\n  gitconfig\n  zshrc.sh\n');
    for (const hidden of ['DUMMY_PRIVATE_CONTENT', 'DUMMY_PRIVATE_NAME', 'README.md', '.ballin-backup.json', 'ballin_config']) {
      assert.notInclude(result.stdout, hidden);
    }
    const after = state(); assert.deepEqual({ ...after, requests: [] }, { ...before, requests: [] });
    assert.lengthOf(after.requests.filter((request) => request.endpoint.includes('/git/blobs/')), 2);
    preserved();
  });
  it('does not invent read options when remote inventory is unavailable', () => {
    const value = state(); value.faults.tree = { truncated: true }; save(value);
    const result = run(['read']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.include(result.stderr, 'expected one snapshot');
    assert.include(result.stderr, 'could not be read completely');
    assert.notInclude(result.stderr, 'no supported snapshot found'); preserved();
  });
  it('keeps no-selector usage available without configured storage', () => {
    fs.writeFileSync(configPath, JSON.stringify({ backup: { repository: null }, analytics: { enabled: 'false' } }));
    const result = run(['read']); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.include(result.stderr, 'expected one snapshot'); assert.include(result.stderr, 'not configured');
    assert.deepEqual(state().requests, []);
  });
  it('shows actual saved options for unmatched selectors using the same complete inventory', () => {
    save(fixtureState({ gitconfig: 'saved git\n', brackets_extensions: 'retired\n', DUMMY_PRIVATE_NAME: 'unrelated\n' }));
    for (const name of ['zshrc.sh', 'brackets_extensions', '.ballin-backup.json', 'DUMMY_PRIVATE_SELECTOR']) {
      const before = state(); before.requests = []; save(before);
      const result = run(['read', name]); assert.equal(result.status, 1);
      assert.include(result.stdout, 'Saved snapshots:\n  gitconfig\n');
      assert.include(result.stderr, 'no supported snapshot found');
      assert.notInclude(result.stdout + result.stderr, 'backup list');
      assert.notInclude(result.stdout + result.stderr, 'DUMMY_PRIVATE');
      assert.notInclude(result.stdout, '  zshrc.sh');
      assert.lengthOf(state().requests, 6);
      assert.lengthOf(state().requests.filter((request) => request.endpoint.includes('/git/trees/')), 1);
      assert.lengthOf(state().requests.filter((request) => request.endpoint.includes('/git/blobs/')), 1);
      assert.deepEqual({ ...state(), requests: [] }, before); preserved();
    }
  });
  it('reports a complete marker-only inventory for unmatched reads without inventing options', () => {
    const result = run(['read', 'zshrc.sh']); assert.equal(result.status, 1);
    assert.equal(result.stdout, 'No current snapshots are saved in this backup.\n');
    assert.include(result.stderr, 'no supported snapshot found'); assert.notInclude(result.stderr, 'backup list'); preserved();
  });
  it('keeps list plain on a TTY and preserves exact explicit-read bytes without execution', () => {
    const bytes = '\x1b[31m$(touch forbidden)\x1b[0m\r\n\n'; save(fixtureState({ 'zshrc.sh': bytes }));
    const preload = 'Object.defineProperty(process.stdout, "isTTY", { value: true });';
    for (const env of [{ TERM: 'xterm', FORCE_COLOR: '1' }, { TERM: 'xterm', NO_COLOR: '1' }]) {
      const listed = run(['list'], env, preload); assert.equal(listed.status, 0); assert.notInclude(listed.stdout, '\x1b');
      const read = run(['read', 'zshrc.sh'], env, preload); assert.equal(read.status, 0); assert.equal(read.stdout, bytes);
    }
    assert.isFalse(fs.existsSync(path.join(checkout, 'forbidden'))); preserved();
  });
  it('preserves coarse command analytics and opt-outs without inspection events or private values', () => {
    const capture = createAnalyticsCapture(root);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')); config.analytics.enabled = 'true'; fs.writeFileSync(configPath, JSON.stringify(config));
    save(fixtureState({ gitconfig: 'DUMMY_PRIVATE_CONTENT\n', DUMMY_PRIVATE_NAME: 'unrelated\n' }));
    const beforeId = fs.readFileSync(capture.installIdPath, 'utf8');
    const result = run(['list'], capture.env); assert.equal(result.status, 0, result.stderr);
    const events = capture.readEvents(); assert.lengthOf(events, 1); assert.equal(events[0].command, 'ballin backup'); assert.isUndefined(events[0].event);
    assert.equal(fs.readFileSync(capture.installIdPath, 'utf8'), beforeId);
    const payload = JSON.stringify(events);
    for (const text of ['gitconfig', 'DUMMY_PRIVATE', fixtureDestination.id, fixtureDestination.ownerId, fixtureDestination.name, state().head, 'entries', 'snapshot']) assert.notInclude(payload, text);
    capture.clear(); assert.equal(run(['list'], { ...capture.env, BALLIN_NO_ANALYTICS: '1' }).status, 0); assert.deepEqual(capture.readEvents(), []);
    assert.equal(run(['list'], { ...capture.env, BALLIN_NO_COMMAND_ANALYTICS: '1' }).status, 0); assert.deepEqual(capture.readEvents(), []);
    assert.equal(run(['list'], { ...capture.env, BALLIN_TEST_ANALYTICS_MODE: 'throw' }).status, 0);
    assert.deepEqual(capture.readEvents(), []);
  });
});
