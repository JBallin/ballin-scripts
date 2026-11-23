const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const source = path.resolve(__dirname, '..');

describe('trusted installed self-update boundary', function () {
  this.timeout(15000);
  let root: string, home: string, tools: string, upstream: string, installed: string;
  let before: string, target: string, stateFile: string, preload: string;
  const env = (extra: NodeJS.ProcessEnv = {}) => testChildEnvironment({
    HOME: home, PATH: `${tools}:${path.join(home, '.local/bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    BALLIN_UPDATE_TRACK: 'main', BALLIN_BACKUP_CHOICE: 'no',
    BALLIN_TEST_CONFIG_PATH: path.join(installed, 'ballin.config.json'),
    NODE_OPTIONS: preload ? `--require=${preload}` : undefined, FIXTURE_TTY: '1', ...extra,
  });
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd, env: env(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const records = (name: string): string[] => fs.existsSync(path.join(home, name))
    ? fs.readFileSync(path.join(home, name), 'utf8').trim().split('\n').filter(Boolean) : [];
  const receiptFile = () => path.join(installed, '.git/ballin-install.json');
  const selection = (sha = before, kind = 'branch', value = 'main') => ({
    kind, value: kind === 'sha' ? sha : value, sha, minimumNode: '24.12.0', releaseId: kind === 'release' ? '123' : '-',
  });
  const saveReceipt = (kind = 'branch', value = 'main', sha = before) => {
    fs.writeFileSync(receiptFile(), JSON.stringify(selection(sha, kind, value)) + '\n');
    if (kind === 'release') git(installed, ['tag', value, sha]);
  };
  const selectRelease = (tag: string) => {
    git(upstream, ['tag', tag, target]);
    fs.writeFileSync(stateFile, JSON.stringify({ sha: target, tag }));
  };
  const run = (input = '', extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [path.join(installed, 'bin/ballin'), 'self-update'], { cwd: home, env: env(extra), input, encoding: 'utf8', timeout: 12000 });
  const runHelper = (input = '', extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [path.join(source, 'commands/repo_update.ts'), 'self-update', installed, 'branch', 'main', target, '24.12.0', '-',
      JSON.stringify({ directory: path.join(home, '.local/bin'), target: path.join(home, '.local/bin/ballin'), snapshot: 'null' })],
    { cwd: home, env: env(extra), input, encoding: 'utf8', timeout: 12000 });
  const preserved = () => ({
    config: fs.readFileSync(path.join(installed, 'ballin.config.json'), 'utf8'),
    cache: fs.readFileSync(path.join(installed, '.backup-cache/prior'), 'utf8'),
  });
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-trusted-update-')));
    home = path.join(root, 'home'); tools = path.join(root, 'tools'); upstream = path.join(root, 'upstream');
    installed = path.join(home, '.ballin-scripts'); stateFile = path.join(root, 'selection.json'); preload = '';
    for (const dir of [home, tools, upstream, path.join(home, '.local/bin')]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of ['commands', 'config', 'bin', 'completions']) fs.cpSync(path.join(source, dir), path.join(upstream, dir), { recursive: true });
    for (const file of ['install.sh', 'quickstart.sh', 'package.json']) fs.copyFileSync(path.join(source, file), path.join(upstream, file));
    fs.writeFileSync(path.join(upstream, '.gitignore'), 'ballin.config.json\n.backup-cache/\n.analytics/\n');
    fs.copyFileSync(path.join(upstream, 'commands/install_setup.ts'), path.join(upstream, 'commands/real_install_setup.ts'));
    fs.writeFileSync(path.join(upstream, 'commands/install_setup.ts'), [
      "if (require.main !== module) module.exports = require('./real_install_setup.ts'); else {",
      "const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');",
      "fs.appendFileSync(path.join(process.env.HOME, 'setup-runs'), process.argv.slice(2).join(' ') + '\\n');",
      "if (process.env.FIXTURE_REAL_SETUP === '1') { const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'real_install_setup.ts'), ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(r.status || 0); }",
      "if (process.env.FIXTURE_SETUP_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SETUP_SIGNAL);",
      "if (process.env.FIXTURE_SETUP_STATUS) process.stderr.write('Fixture setup failure.\\n');",
      'process.exit(Number(process.env.FIXTURE_SETUP_STATUS || 0));', '}',
    ].join('\n'));
    git(upstream, ['init', '-q', '-b', 'main']); git(upstream, ['add', '.']); git(upstream, ['commit', '-qm', 'installed trusted code']);
    before = git(upstream, ['rev-parse', 'HEAD']);
    const installer = path.join(upstream, 'install.sh');
    fs.writeFileSync(installer, fs.readFileSync(installer, 'utf8').replace('{ # Parse the complete body before starting installation.\n',
      '{ # Parse the complete body before starting installation.\nprintf \'%s\\n\' "${1:-}" >> "$HOME/candidate-starts"\n'));
    fs.writeFileSync(path.join(upstream, 'revision-fixture'), 'selected revision\n');
    git(upstream, ['add', '.']); git(upstream, ['commit', '-qm', 'selected candidate']); target = git(upstream, ['rev-parse', 'HEAD']);
    git(home, ['clone', '-q', upstream, installed]); git(installed, ['checkout', '-q', '-B', 'installed', before]);
    git(installed, ['remote', 'set-url', 'origin', 'https://github.com/JBallin/ballin-scripts.git']);
    fs.writeFileSync(path.join(installed, 'ballin.config.json'), fs.readFileSync(path.join(source, 'config/.defaultConfig.json')));
    fs.mkdirSync(path.join(installed, '.backup-cache')); fs.writeFileSync(path.join(installed, '.backup-cache/prior'), 'synthetic saved cache\n');
    fs.writeFileSync(stateFile, JSON.stringify({ sha: target, tag: 'v2.0.0' }));
    fs.writeFileSync(path.join(tools, 'git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),path=require('path');let args=process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME,'git-calls'),JSON.stringify(args)+'\\n');
if(args[0]==='fetch'&&process.env.FIXTURE_FETCH_SIGNAL)process.kill(process.pid,process.env.FIXTURE_FETCH_SIGNAL);
args=args.map(v=>v==='https://github.com/JBallin/ballin-scripts.git'?${JSON.stringify(upstream)}:v);
if(args.some(v=>/^(?:https?:|git@)/.test(v)))process.exit(97);
const r=cp.spawnSync('/usr/bin/git',args,{stdio:'inherit'});if(r.signal)process.kill(process.pid,r.signal);process.exit(r.status??1);
`, { mode: 0o755 });
    fs.writeFileSync(path.join(tools, 'curl'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),path=require('path');const args=process.argv.slice(2),url=args.find(v=>v.startsWith('https://')),out=args.includes('-o')?args[args.indexOf('-o')+1]:null,state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
fs.appendFileSync(path.join(process.env.HOME,'curl-calls'),url+'\\n');let body;
if(url.includes('/git/ref/heads/')){body=JSON.stringify({object:{sha:state.sha,type:'commit'}});if(state.next){state.sha=state.next;delete state.next;fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state));}}
else if(url.includes('/releases/'))body=JSON.stringify({tag_name:state.tag,draft:false,prerelease:false,id:123,published_at:'2026-01-01T00:00:00Z'});
else if(url.includes('/git/ref/tags/'))body=JSON.stringify({object:{sha:state.sha,type:'commit'}});
else {const prefix='https://raw.githubusercontent.com/JBallin/ballin-scripts/';if(!url.startsWith(prefix))process.exit(97);const [sha,...parts]=url.slice(prefix.length).split('/'),file=parts.join('/');if(!/^[a-f0-9]{40}$/.test(sha)||!['package.json','install.sh','quickstart.sh','commands/repo_update.ts'].includes(file))process.exit(97);const r=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(upstream)},'show',sha+':'+file],{encoding:'utf8'});if(r.status)process.exit(97);body=r.stdout;}
if(out){fs.writeFileSync(out,body);process.stdout.write('200');}else if(args.length===3&&args[0]==='-q'&&args[1]==='-fsSL')process.stdout.write(body);else process.exit(97);
`, { mode: 0o755 });
    preload = path.join(root, 'input.cjs');
    fs.writeFileSync(preload, `const fs=require('fs'),cp=require('child_process'),path=require('path');require('tty').isatty=()=>process.env.FIXTURE_TTY==='1';
const read=fs.readSync;fs.readSync=function(fd,buffer,...args){const n=read.call(this,fd,buffer,...args);if(fd===0&&n&&buffer[0]===10&&process.env.FIXTURE_CHANGE_RECEIPT==='1'){process.env.FIXTURE_CHANGE_RECEIPT='';const file=path.join(process.env.HOME,'.ballin-scripts/.git/ballin-install.json'),receipt=JSON.parse(fs.readFileSync(file));receipt.minimumNode='24.13.0';fs.writeFileSync(file,JSON.stringify(receipt));}return n;};
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){if(command==='git'&&args[0]==='status'&&process.env.FIXTURE_CHANGE_APPLIED_RECEIPT==='1'){const file=path.join(process.env.HOME,'.ballin-scripts/.git/ballin-install.json');if(fs.existsSync(file)){const receipt=JSON.parse(fs.readFileSync(file));if(receipt.sha===process.env.FIXTURE_SELECTED_SHA){process.env.FIXTURE_CHANGE_APPLIED_RECEIPT='';receipt.minimumNode='24.13.0';fs.writeFileSync(file,JSON.stringify(receipt));}}}if(command==='/bin/bash'&&args[1]==='--ballin-applied-v2'){if(process.env.FIXTURE_HANDOFF_ERROR)return {error:new Error('fixture launch failure'),status:null,signal:null};if(process.env.FIXTURE_REPLACE_COMMAND)fs.writeFileSync(path.join(process.env.HOME,'.local/bin/ballin'),'concurrent command\\n');}return spawn.call(this,command,args,options);};
`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const testCase of ['automatic', 'non-TTY', 'No', 'EOF', 'partial input', 'invalid then No']) {
    it(`never executes the candidate on ${testCase} without provenance`, () => {
      const data = preserved();
      const input = testCase === 'No' ? 'n\n' : testCase === 'partial input' ? 'y' : testCase === 'invalid then No' ? 'invalid\nn\n' : '';
      const result = run(input, { BALLIN_AUTOMATIC_UPDATE: testCase === 'automatic' ? '1' : undefined, FIXTURE_TTY: testCase === 'non-TTY' ? '0' : '1' });
      assert.equal(result.status, ['automatic', 'non-TTY'].includes(testCase) ? 1 : 0, result.stdout + result.stderr);
      assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.deepEqual(records('candidate-starts'), []);
      assert.deepEqual(records('setup-runs'), []); assert.deepEqual(preserved(), data); assert.isFalse(fs.existsSync(receiptFile()));
      if (testCase === 'invalid then No') assert.include(result.stdout, 'Enter Yes or No.');
    });
  }
  for (const kind of ['major', 'downgrade', 'track', 'stale', 'same-SHA track']) {
    it(`refuses automatic ${kind} transition before candidate execution`, () => {
      if (kind === 'major' || kind === 'downgrade') { saveReceipt('release', kind === 'major' ? 'v1.0.0' : 'v3.0.0'); selectRelease('v2.0.0'); }
      else if (kind === 'stale') saveReceipt('branch', 'main', target);
      else saveReceipt('sha', before);
      if (kind === 'same-SHA track') fs.writeFileSync(stateFile, JSON.stringify({ sha: before, tag: 'v2.0.0' }));
      const receipt = fs.readFileSync(receiptFile(), 'utf8');
      const result = run('', { BALLIN_AUTOMATIC_UPDATE: '1', BALLIN_UPDATE_TRACK: ['major','downgrade'].includes(kind) ? undefined : 'main' });
      assert.equal(result.status, 1, result.stdout + result.stderr); assert.include(result.stderr, 'Confirmation required.');
      assert.deepEqual(records('candidate-starts'), []); assert.deepEqual(records('setup-runs'), []);
      assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.equal(fs.readFileSync(receiptFile(), 'utf8'), receipt);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`preserves ${signal} before candidate execution`, () => {
      saveReceipt(); const receipt = fs.readFileSync(receiptFile(), 'utf8'), data = preserved();
      const result = run('y\n', { FIXTURE_FETCH_SIGNAL: signal });
      assert.equal(result.status, signal === 'SIGINT' ? 130 : 143, result.stdout + result.stderr);
      assert.equal(git(installed, ['rev-parse', 'HEAD']), before); assert.equal(fs.readFileSync(receiptFile(), 'utf8'), receipt);
      assert.deepEqual(records('candidate-starts'), []); assert.deepEqual(preserved(), data);
    });
  }
  it('confirms once, applies once and runs only the resolved candidate and setup', () => {
    const data = preserved(); fs.writeFileSync(stateFile, JSON.stringify({ sha: target, tag: 'v2.0.0', next: 'b'.repeat(40) }));
    const result = run('Y\n'); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), target); assert.deepEqual(records('candidate-starts'), ['--ballin-applied-v2']);
    assert.lengthOf(records('setup-runs'), 1); assert.equal(result.stdout.split('Change the installed revision/track?').length - 1, 1);
    assert.lengthOf(records('git-calls').map(line=>JSON.parse(line)).filter(args=>args[0]==='fetch'&&args.at(-1)===target), 1);
    assert.lengthOf(records('curl-calls').filter(url=>url.includes('/git/ref/heads/')), 1); assert.deepEqual(preserved(), data);
  });
  for (const release of [false, true]) {
    it(`retains compatible automatic ${release ? 'same-major release' : 'main fast-forward'} updates`, () => {
      if (release) { saveReceipt('release','v1.0.0'); selectRelease('v1.1.0'); } else saveReceipt();
      const result = run('', { BALLIN_AUTOMATIC_UPDATE: '1', BALLIN_UPDATE_TRACK: release ? undefined : 'main' });
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.notInclude(result.stdout, 'Change the installed revision/track?');
      assert.deepEqual(records('candidate-starts'), ['--ballin-applied-v2']); assert.lengthOf(records('setup-runs'), 1);
    });
  }
  it('preserves a same-HEAD receipt change made during confirmation', () => {
    saveReceipt('sha', before);
    const result = run('yes\n', { FIXTURE_CHANGE_RECEIPT: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr); assert.include(result.stderr, 'Checkout changed after confirmation.');
    assert.equal(git(installed, ['rev-parse','HEAD']), before); assert.deepEqual(records('candidate-starts'), []);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile())).minimumNode, '24.13.0');
  });
  for (const fail of ['setup', 'launch', 'command target']) {
    it(`reports truthful ${fail} failure after application and permits a clean retry`, () => {
      saveReceipt(); const data = preserved();
      const result = runHelper('', { FIXTURE_SETUP_STATUS: fail === 'setup' ? '41' : undefined, FIXTURE_HANDOFF_ERROR: fail === 'launch' ? '1' : undefined, FIXTURE_REPLACE_COMMAND: fail === 'command target' ? '1' : undefined });
      assert.equal(result.status, fail === 'setup' ? 41 : 1, result.stdout + result.stderr);
      assert.equal(git(installed,['rev-parse','HEAD']),target); assert.equal(JSON.parse(fs.readFileSync(receiptFile())).sha,target);
      assert.include(result.stderr, `Ballin checkout is now ${target}, but setup refresh failed.`); assert.notInclude(result.stdout,'Ballin updated:');
      assert.deepEqual(preserved(),data);
      if (fail === 'command target') assert.equal(fs.readFileSync(path.join(home,'.local/bin/ballin'),'utf8'),'concurrent command\n');
      const retry = run(); assert.equal(retry.status,0,retry.stdout+retry.stderr); assert.notInclude(retry.stdout,'Change the installed revision/track?');
    });
  }
  it('rejects a changed applied receipt before launching candidate code', () => {
    saveReceipt(); const data=preserved();
    const result=runHelper('',{FIXTURE_CHANGE_APPLIED_RECEIPT:'1',FIXTURE_SELECTED_SHA:target});
    assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(git(installed,['rev-parse','HEAD']),target);
    assert.include(result.stderr,'Applied-update receipt does not match');assert.include(result.stderr,`Ballin checkout is now ${target}`);
    assert.deepEqual(records('candidate-starts'),[]);assert.deepEqual(preserved(),data);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile())).minimumNode,'24.13.0');
  });
  for (const signal of ['SIGINT','SIGTERM']) {
    it(`preserves ${signal} after application without false completion`, () => {
      saveReceipt(); const result=runHelper('',{FIXTURE_SETUP_SIGNAL:signal});
      assert.equal(result.status,signal==='SIGINT'?130:143,result.stdout+result.stderr);
      assert.equal(git(installed,['rev-parse','HEAD']),target);assert.equal(JSON.parse(fs.readFileSync(receiptFile())).sha,target);
      assert.deepEqual(records('candidate-starts'),['--ballin-applied-v2']);assert.notInclude(result.stdout,'Ballin updated:');
      assert.notInclude(result.stderr,'setup refresh failed');
    });
  }
  for (const snapshot of ['{', '{}', JSON.stringify({ directory: '/fixture', target: '/fixture/ballin', snapshot: '{}' })]) {
    it(`rejects malformed command-preflight data before application: ${snapshot}`, () => {
      const selected=selection(target);
      const result=spawnSync(process.execPath,[path.join(source,'commands/repo_update.ts'),'self-update',installed,selected.kind,selected.value,selected.sha,selected.minimumNode,selected.releaseId,snapshot],{env:env(),encoding:'utf8'});
      assert.equal(result.status,1,result.stdout+result.stderr); assert.include(result.stderr,'Invalid command preflight');
      assert.equal(git(installed,['rev-parse','HEAD']),before); assert.deepEqual(records('candidate-starts'),[]);
      assert.isFalse(records('git-calls').map(line=>JSON.parse(line)).some(args=>args[0]==='fetch'));
    });
  }
  it('rejects unsupported legacy self-update continuations without service calls', () => {
    for (const marker of ['--ballin-resolved-v1','--ballin-resolved-v2']) {
      const result=spawnSync('/bin/bash',[path.join(installed,'install.sh'),marker,'sha',target,target,'24.12.0','-','self-update'],{env:env(),encoding:'utf8'});
      assert.equal(result.status,1,result.stdout+result.stderr); assert.deepEqual(records('curl-calls'),[]); assert.deepEqual(records('candidate-starts'),[]);
    }
  });
  for (const field of ['root','kind','value','sha','minimumNode','releaseId']) {
    it(`binds the applied continuation's ${field}`, () => {
      saveReceipt(); const success=run(); assert.equal(success.status,0,success.stdout+success.stderr);
      const selected=selection(target); const args=[installed,selected.kind,selected.value,selected.sha,selected.minimumNode,selected.releaseId];
      const index=['root','kind','value','sha','minimumNode','releaseId'].indexOf(field);
      if(field==='root')git(upstream,['remote','add','origin','https://github.com/JBallin/ballin-scripts.git']);
      args[index]=field==='root'?upstream:field==='kind'?'sha':field==='sha'?'b'.repeat(40):field==='minimumNode'?'24.13.0':field==='releaseId'?'999':'other';
      const result=spawnSync(process.execPath,[path.join(source,'commands/repo_update.ts'),'verify-applied',...args],{env:env(),encoding:'utf8'});
      assert.equal(result.status,1,result.stdout+result.stderr); assert.lengthOf(records('setup-runs'),1);
    });
  }
  it('rejects a noncanonical spelling of an otherwise valid applied root', () => {
    saveReceipt(); const selected=selection();
    const result=spawnSync(process.execPath,[path.join(source,'commands/repo_update.ts'),'verify-applied',installed+'/../.ballin-scripts',selected.kind,selected.value,selected.sha,selected.minimumNode,selected.releaseId],{env:env(),encoding:'utf8'});
    assert.equal(result.status,1,result.stdout+result.stderr);assert.include(result.stderr,'Applied-update checkout does not match');
    assert.deepEqual(records('candidate-starts'),[]);assert.deepEqual(records('setup-runs'),[]);
  });
  it('keeps the genuine v1 refusal and reviewed manual recovery path distinct', function () {
    // One coherent refusal -> decline -> recovery -> track-consent -> automatic journey.
    this.timeout(30000);
    // Frozen pre-repair source from 442bc80; these fixtures are never product dependencies.
    const legacy=fs.readFileSync(path.join(source,'test/fixtures/revision-bootstrap-v1.sh'),'utf8').replace(/^#![^\n]*\n/,'').trimEnd();
    const file=path.join(installed,'install.sh');
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/(# BEGIN RELEASE BOOTSTRAP\nballin_entry='install.sh'\nballin_embedded_version='1.0.0'\n)[\s\S]*?# END RELEASE BOOTSTRAP/, (_match: string, prefix: string) => prefix+legacy+'\n# END RELEASE BOOTSTRAP'));
    fs.copyFileSync(path.join(source,'test/fixtures/repo-update-v1.ts.txt'),path.join(installed,'commands/repo_update.ts'));
    const metadata=JSON.parse(fs.readFileSync(path.join(installed,'package.json'))); metadata.ballin.installerProtocol=1; fs.writeFileSync(path.join(installed,'package.json'),JSON.stringify(metadata));
    git(installed,['add','.']);git(installed,['commit','-qm','obsolete prelaunch contract']);
    const legacyHead=git(installed,['rev-parse','HEAD']),data=preserved(); saveReceipt('sha',legacyHead,legacyHead);
    const previousReceipt=fs.readFileSync(receiptFile(),'utf8');
    const refusal=run();assert.equal(refusal.status,1,refusal.stdout+refusal.stderr);assert.include(refusal.stderr,'unsupported installer contract');
    assert.deepEqual(records('candidate-starts'),[]);assert.equal(git(installed,['rev-parse','HEAD']),legacyHead);assert.equal(fs.readFileSync(receiptFile(),'utf8'),previousReceipt);assert.deepEqual(preserved(),data);
    const explicit=spawnSync('/bin/bash',[file,'--sha',target],{env:env(),encoding:'utf8'});assert.equal(explicit.status,1);assert.include(explicit.stderr,'unsupported installer contract');assert.deepEqual(records('candidate-starts'),[]);
    const reviewed=path.join(root,'reviewed-install.sh');fs.copyFileSync(path.join(source,'install.sh'),reviewed);
    const unsupported=spawnSync('/bin/bash',[reviewed,'--self-update'],{env:env(),encoding:'utf8'});assert.equal(unsupported.status,1);assert.include(unsupported.stderr,'Installed updater uses an unsupported contract.');
    const guide=fs.readFileSync(path.join(source,'docs/installation-testing.md'),'utf8');
    const start=guide.indexOf('CANDIDATE_SHA=FULL_REVIEWED_COMMIT_SHA');assert.isAtLeast(start,0);
    const command=guide.slice(start,guide.indexOf('\n```',start)).replace('FULL_REVIEWED_COMMIT_SHA',target);
    const recover=(input:string)=>spawnSync('/bin/bash',['-c',command],{input,env:env({FIXTURE_REAL_SETUP:'1'}),encoding:'utf8',timeout:12000});
    const metadataFile=path.join(installed,'package.json'),metadataBytes=fs.readFileSync(metadataFile);fs.appendFileSync(metadataFile,' ');
    const dirty=recover('Yes\n');assert.equal(dirty.status,1);assert.include(dirty.stderr,'local changes');assert.equal(git(installed,['rev-parse','HEAD']),legacyHead);assert.isTrue(fs.readFileSync(metadataFile).equals(Buffer.concat([metadataBytes,Buffer.from(' ')])));fs.writeFileSync(metadataFile,metadataBytes);
    const declined=recover('No\n');assert.equal(declined.status,0,declined.stdout+declined.stderr);assert.equal(git(installed,['rev-parse','HEAD']),legacyHead);assert.equal(fs.readFileSync(receiptFile(),'utf8'),previousReceipt);assert.deepEqual(preserved(),data);
    const accepted=recover('Yes\nn\n');assert.equal(accepted.status,0,accepted.stdout+accepted.stderr);assert.equal(git(installed,['rev-parse','HEAD']),target);assert.deepEqual(preserved(),data);
    assert.isTrue(fs.lstatSync(path.join(home,'.local/bin/ballin')).isSymbolicLink());
    const next=run('',{BALLIN_AUTOMATIC_UPDATE:'1'});assert.equal(next.status,1,next.stdout+next.stderr);assert.include(next.stderr,'Confirmation required.');
    assert.equal(JSON.parse(fs.readFileSync(receiptFile())).kind,'sha');
    const tracking=run('Yes\n');assert.equal(tracking.status,0,tracking.stdout+tracking.stderr);assert.equal(JSON.parse(fs.readFileSync(receiptFile())).kind,'branch');
    const automatic=run('',{BALLIN_AUTOMATIC_UPDATE:'1'});assert.equal(automatic.status,0,automatic.stdout+automatic.stderr);assert.notInclude(automatic.stdout,'Change the installed revision/track?');
  });
});
