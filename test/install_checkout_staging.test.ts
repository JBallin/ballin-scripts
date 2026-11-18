const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

// Real Git and the selected helper exercise retry safety; only network and the
// final typed setup are fixtures. No installer runs against the caller's HOME.
describe('fresh installer checkout publication', function() {
  this.timeout(20000);
  let root: string, home: string, tools: string, upstream: string, installer: string, selected: string;
  let realGit: string, realMv: string;
  const env = (extra: NodeJS.ProcessEnv = {}) => testChildEnvironment({
    HOME: home, PATH: tools, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    FIXTURE_UPSTREAM: upstream, FIXTURE_REAL_GIT: realGit, FIXTURE_REAL_MV: realMv,
    FIXTURE_SELECTED_SHA: selected, FIXTURE_HELPER: path.resolve(__dirname, '../commands/repo_update.ts'), ...extra,
  });
  const command = (name: string) => {
    const found = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
    assert.exists(found, `${name} is required`); return found!;
  };
  const git = (args: string[], cwd = upstream): string => {
    const result = spawnSync(realGit, args, { cwd, env: env(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const writeTool = (name: string, body: string) => fs.writeFileSync(path.join(tools, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(installer, [], { env: env(extra), encoding: 'utf8', input: 'yes\n' });
  const noPartialCheckout = () => {
    assert.isFalse(fs.existsSync(path.join(home, '.ballin-scripts')));
    assert.isEmpty(fs.readdirSync(home).filter((name: string) => name.startsWith('.ballin-install.')));
    assert.equal(fs.readFileSync(path.join(home, 'earlier-data'), 'utf8'), 'keep\n');
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-publish-'));
    home = path.join(root, 'home'); tools = path.join(root, 'tools'); upstream = path.join(root, 'upstream');
    for (const dir of [home, tools, upstream]) fs.mkdirSync(dir);
    realGit = command('git'); realMv = command('mv');
    for (const name of ['bash', 'uname', 'mkdir', 'mktemp', 'rm', 'cp']) fs.symlinkSync(command(name), path.join(tools, name));
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    fs.writeFileSync(path.join(home, 'earlier-data'), 'keep\n');
    git(['init', '-q', '-b', 'main']);
    for (const entry of ['install.sh', 'quickstart.sh', 'commands/repo_update.ts', 'commands/install_setup.ts', 'bin/ballin', 'package.json']) {
      const file = path.join(upstream, entry); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry === 'commands/install_setup.ts' ? "process.stdout.write('fixture setup\\n');\n" : entry === 'package.json' ? '{}\n' : 'fixture\n');
    }
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ ballin: { installerProtocol: 2 }, engines: { node: '>=24.12' } }));
    git(['add', '.']); git(['commit', '-qm', 'fixture']); selected = git(['rev-parse', 'HEAD']);
    writeTool('git', `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2), operation=args[0], official='https://github.com/JBallin/ballin-scripts.git';
if(operation==='clone') {
  if(args[1]!=='--no-checkout'||args[2]!==official||!args[3].startsWith(path.join(process.env.HOME,'.ballin-install.'))||path.basename(args[3])!=='.ballin-scripts') process.exit(97);
  args[2]=process.env.FIXTURE_UPSTREAM;
}
if(operation==='fetch') {
  if(args[2]!==official) process.exit(98);
  if(process.env.FIXTURE_FETCH_SIGNAL) process.kill(process.pid,process.env.FIXTURE_FETCH_SIGNAL);
  if(process.env.FIXTURE_FETCH_STATUS) process.exit(Number(process.env.FIXTURE_FETCH_STATUS));
  args[2]=process.env.FIXTURE_UPSTREAM;
}
const result=cp.spawnSync(process.env.FIXTURE_REAL_GIT,args,{stdio:'inherit',env:process.env});
if(result.status!==0) process.exit(result.status||1);
if(operation==='clone') {
  const configured=cp.spawnSync(process.env.FIXTURE_REAL_GIT,['-C',args[3],'remote','set-url','origin',official],{stdio:'inherit',env:process.env});
  if(configured.status!==0) process.exit(configured.status||1);
  if(process.env.FIXTURE_CLONE_SIGNAL) process.kill(process.pid,process.env.FIXTURE_CLONE_SIGNAL);
  if(process.env.FIXTURE_CLONE_STATUS) process.exit(Number(process.env.FIXTURE_CLONE_STATUS));
}
`);
    writeTool('mv', `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const target=path.join(process.env.HOME,'.ballin-scripts'),race=process.env.FIXTURE_MV_RACE;
if(race==='directory'||race==='empty') {fs.mkdirSync(target);if(race==='directory')fs.writeFileSync(path.join(target,'user-data'),'preserve');}
if(race==='file') fs.writeFileSync(target,'preserve');
if(race==='symlink') {const other=path.join(process.env.HOME,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'user-data'),'preserve');fs.symlinkSync(other,target);}
const result=cp.spawnSync(process.env.FIXTURE_REAL_MV,process.argv.slice(2),{stdio:'inherit',env:process.env});
// Retain the real no-clobber operation while covering both portable refusal statuses.
const refusal=process.env.FIXTURE_MV_REFUSAL_STATUS;
process.exit(race&&refusal!==undefined?Number(refusal):result.status||0);
`);
    installer = path.join(root, 'install.sh');
    const source = fs.readFileSync(path.resolve(__dirname, '../install.sh'), 'utf8').replace('ballin_select "$@" || exit $?', `
ballin_kind=sha; ballin_value="$FIXTURE_SELECTED_SHA"; ballin_sha="$ballin_value"
ballin_minimum=24.12.0; ballin_release_id=-; ballin_mode=install
ballin_download() { cp "$FIXTURE_HELPER" "$2"; }
`);
    fs.writeFileSync(installer, source, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const failure of ['fetch', 'SIGINT', 'SIGTERM', '130', '143', 'clone', 'clone-SIGINT', 'clone-SIGTERM', 'contract']) {
    it(`retries after ${failure} without leaving an empty installation or losing prior data`, () => {
      const options: NodeJS.ProcessEnv = {};
      if (failure === 'fetch') options.FIXTURE_FETCH_STATUS = '17';
      else if (failure === 'SIGINT' || failure === 'SIGTERM') options.FIXTURE_FETCH_SIGNAL = failure;
      else if (failure === '130' || failure === '143') options.FIXTURE_FETCH_STATUS = failure;
      else if (failure === 'clone') options.FIXTURE_CLONE_STATUS = '17';
      else if (failure.startsWith('clone-')) options.FIXTURE_CLONE_SIGNAL = failure.slice(6);
      else {
        fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ ballin: { installerProtocol: 3 }, engines: { node: '>=24.12' } }));
        git(['commit', '-qam', 'unsupported fixture']); options.FIXTURE_SELECTED_SHA = git(['rev-parse', 'HEAD']);
      }
      const failed = run(options);
      const expected = failure.includes('SIGINT') || failure === '130' ? 130 : failure.includes('SIGTERM') || failure === '143' ? 143 : 1;
      assert.equal(failed.status, expected, failed.stdout + failed.stderr);
      assert.notInclude(failed.stdout, 'fixture setup'); noPartialCheckout();
      const retry = run(); assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      const installed = path.join(home, '.ballin-scripts');
      assert.equal(git(['rev-parse', 'HEAD'], installed), selected);
      assert.equal(git(['status', '--porcelain'], installed), '');
      assert.equal(JSON.parse(fs.readFileSync(path.join(installed, '.git/ballin-install.json'), 'utf8')).sha, selected);
      assert.include(retry.stdout, 'fixture setup');
      assert.equal(fs.readFileSync(path.join(home, 'earlier-data'), 'utf8'), 'keep\n');
      assert.isEmpty(fs.readdirSync(home).filter((name: string) => name.startsWith('.ballin-install.')));
    });
  }
  for (const race of ['directory', 'empty', 'file', 'symlink']) for (const refusal of ['native', '0', '1']) it(`preserves a concurrently created ${race} at publication (mv status ${refusal})`, () => {
    const result = run({ FIXTURE_MV_RACE: race, ...(refusal === 'native' ? {} : { FIXTURE_MV_REFUSAL_STATUS: refusal }) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.notInclude(result.stdout, 'fixture setup');
    assert.match(result.stderr, /(?:The installation destination changed\.|Unable to publish the prepared installation\.)/u);
    const target = path.join(home, '.ballin-scripts');
    if (race === 'empty') assert.isEmpty(fs.readdirSync(target));
    else if (race === 'file') assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
    else assert.equal(fs.readFileSync(path.join(target, 'user-data'), 'utf8'), 'preserve');
    if (race === 'symlink') assert.isTrue(fs.lstatSync(target).isSymbolicLink());
    assert.isEmpty(fs.readdirSync(home).filter((name: string) => name.startsWith('.ballin-install.')));
    assert.equal(fs.readFileSync(path.join(home, 'earlier-data'), 'utf8'), 'keep\n');
  });
});
