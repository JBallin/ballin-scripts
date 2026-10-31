const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { createDefaultConfig } = require('../config/setup.ts');
const { createConfigStore } = require('../config/store.ts');
const { restorePortablePreferences, projectPortablePreferences } = require('../config/portable.ts');
const ballin = path.resolve(__dirname, '../bin/ballin');
const defaults = require('../config/.defaultConfig.json');

describe('general preference review', () => {
  let root: string;
  let file: string;
  let guard: string;
  let nvm: string;
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const run = (input = '', env: NodeJS.ProcessEnv = {}, args = ['setup']) => spawnSync(process.execPath, [ballin, ...args], {
    input, encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: '/usr/bin:/bin',
      BALLIN_TEST_CONFIG_PATH: file, NODE_OPTIONS: `--require ${JSON.stringify(guard)}`, ...env }),
  });
  const installNvm = (alias = 'lts/*') => {
    nvm = path.join(root, '.nvm');
    fs.mkdirSync(path.join(nvm, 'alias/lts'), { recursive: true });
    fs.writeFileSync(path.join(nvm, 'alias/default'), alias);
    fs.writeFileSync(path.join(nvm, 'alias/lts/*'), 'v26.13.0');
    fs.mkdirSync(path.join(nvm, 'versions/node/v26.13.0/bin'), { recursive: true });
    fs.writeFileSync(path.join(nvm, 'versions/node/v26.13.0/bin/node'), 'not executed');
    fs.writeFileSync(path.join(nvm, 'nvm.sh'), `nvm() { [ "$1" = version ] && printf 'v26.13.0\\n'; }\n`);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-general-'));
    file = path.join(root, 'ballin.config.json'); guard = path.join(root, 'guard.cjs');
    fs.writeFileSync(guard, `const fs = require('fs');
      const read = fs.readFileSync;
      fs.readFileSync = (file,...args) => {
        if (typeof file === 'string' && /\\.(?:zshrc|bashrc)$/.test(file)) throw Error('General setup must not collect sources');
        return read(file,...args);
      };\n`);
    write(structuredClone(defaults));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const native of [false, true]) for (const enabled of [false, true]) {
    it(`uses saved ${native ? 'native' : 'string'} ${enabled} choices without changing backup ownership`, () => {
      const config = structuredClone(defaults);
      for (const key of Object.keys(config.update)) config.update[key] = native ? enabled : String(enabled);
      config.analytics.enabled = native ? enabled : String(enabled);
      config.backup.includeSensitive = 'true'; config.custom = { retained: true };
      write(config);
      const result = run('\n'.repeat(enabled ? 7 : 5));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Include sensitive'); assert.notInclude(result.stdout, 'GitHub hostname');
      assert.notInclude(result.stdout, 'Create a new backup');
      for (const key of ['npm', 'selfUpdate', 'cleanup', 'softwareupdate']) assert.equal(read().update[key], String(enabled));
      assert.equal(read().analytics.enabled, String(enabled));
      assert.equal(read().backup.includeSensitive, 'true'); assert.deepEqual(read().custom, { retained: true });
      assert.equal(result.stdout.split('docs/optional-capabilities.md').length - 1, 1);
      assert.equal(result.stdout.split('Run `ballin backup setup`').length - 1, 1);
      assert.include(result.stdout, '==> Update preferences'); assert.include(result.stdout, '==> Analytics');
    });
  }
  it('falls back only for absent preferences and retains bundled macOS default Yes', () => {
    write({ custom: true }); const result = run('\n'.repeat(5));
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Install available macOS updates? [Y/n]');
    assert.equal(read().update.softwareupdate, 'true');
  });
  for (const key of ['npm', 'selfUpdate', 'cleanup', 'softwareupdate', 'nvm', 'backup', 'analytics']) {
    for (const value of [null, 'invalid', 1]) it(`rejects invalid ${key}=${value} before prompts`, () => {
      const config = structuredClone(defaults);
      if (key === 'analytics') config.analytics.enabled = value; else config.update[key] = value;
      write(config); const before = fs.readFileSync(file, 'utf8');
      const result = run('y\n'.repeat(9)); assert.equal(result.status, 1);
      assert.include(result.stderr, 'expected true or false'); assert.notInclude(result.stdout, 'Update preferences');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
  }
  for (const enabled of [false, true]) for (const configured of [false, true]) {
    it(`offers automatic backup for configured=${configured}, enabled=${enabled}`, () => {
      const config = structuredClone(defaults); config.update.backup = String(enabled);
      if (configured) config.backup.repository = require('./helpers/repository.ts').fixtureDestination;
      write(config); const result = run('\n'.repeat(6)); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes('Back up to GitHub during updates?'), configured || enabled);
    });
  }
  for (const eligible of [false, true]) for (const enabled of [false, true]) {
    it(`offers NVM for eligible=${eligible}, enabled=${enabled}`, () => {
      if (eligible) installNvm();
      const config = structuredClone(defaults); config.update.nvm = String(enabled); write(config);
      const result = run('\n'.repeat(6)); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes('Keep NVM-managed Node on latest LTS?'), eligible || enabled);
      if (eligible || enabled) assert.include(result.stdout, `latest LTS? ${enabled ? '[Y/n]' : '[y/N]'}`);
      else assert.include(result.stdout, 'NVM can maintain latest LTS Node');
    });
  }
  it('retains first eligible recommendation across ineligibility and cancelled reviews, then preserves No', () => {
    fs.rmSync(file); assert.isTrue(createDefaultConfig(path.resolve(__dirname, '..'), file));
    run('\n'.repeat(5)); assert.isTrue(read()._setup.unreviewedNvm);
    installNvm(); run('n\n'); assert.isTrue(read()._setup.unreviewedNvm);
    const result = run('\n\n\n\nn\nn\n');
    assert.equal(result.status, 0, result.stderr); assert.include(result.stdout, 'latest LTS? [Y/n]');
    assert.notProperty(read(), '_setup'); assert.equal(read().update.nvm, 'false');
    assert.include(run('\n'.repeat(6)).stdout, 'latest LTS? [y/N]');
  });
  for (const absent of ['nvm', 'update']) for (const delayed of [false, true]) {
    it(`recommends the first absent ${absent} NVM choice and preserves confirmed No (delayed=${delayed})`, () => {
      const config = read();
      if (absent === 'nvm') delete config.update.nvm; else delete config.update;
      write(config);
      if (delayed) {
        const ineligible = run('\n'.repeat(5)); assert.equal(ineligible.status, 0, ineligible.stderr);
        assert.notInclude(ineligible.stdout, 'Keep NVM-managed Node'); assert.isUndefined(read().update?.nvm);
      }
      installNvm();
      const cancelled = run(''); assert.equal(cancelled.status, 0, cancelled.stderr); assert.isUndefined(read().update?.nvm);
      const reviewed = run('\n'.repeat(4) + 'n\nn\n'); assert.equal(reviewed.status, 0, reviewed.stderr);
      assert.include(reviewed.stdout, 'latest LTS? [Y/n]'); assert.equal(read().update.nvm, 'false');
      const rerun = run('\n'.repeat(6)); assert.equal(rerun.status, 0, rerun.stderr);
      assert.include(rerun.stdout, 'latest LTS? [y/N]'); assert.equal(read().update.nvm, 'false');
    });
  }
  it('retires pending intent on direct set of false and explicit reset', () => {
    for (const action of ['set', 'reset']) {
      fs.rmSync(file); createDefaultConfig(path.resolve(__dirname, '..'), file);
      const store = createConfigStore({ configPath: file });
      if (action === 'set') store.setConfig('update.nvm', 'false'); else store.resetConfig();
      assert.notProperty(read(), '_setup');
    }
  });
  it('keeps internal intent read-only through the config command', () => {
    const config = read(); config._setup = { unreviewedNvm: true }; write(config);
    const result = run('', {}, ['config', 'set', '_setup.unreviewedNvm', 'false']);
    assert.equal(result.status, 1); assert.isTrue(read()._setup.unreviewedNvm);
  });
  it('uses a direct No confirmed during review as the later NVM default', () => {
    installNvm(); const config = read(); config._setup = { unreviewedNvm: true }; write(config);
    fs.appendFileSync(guard, `const readSync = fs.readSync; let changed = false;
      fs.readSync = (fd,...args) => { if(fd===0 && !changed) { changed=true;
      require(${JSON.stringify(path.resolve(__dirname, '../config/store.ts'))}).createConfigStore({ configPath: process.env.BALLIN_TEST_CONFIG_PATH }).setConfig('update.nvm','false');
      } return readSync(fd,...args); };`);
    const result = run('\n'.repeat(6)); assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'latest LTS? [y/N]'); assert.equal(read().update.nvm, 'false');
    assert.notProperty(read(), '_setup');
  });
  it('does not recreate config removed while a choice is pending', () => {
    fs.appendFileSync(guard, `const readSync = fs.readSync; let changed = false;
      fs.readSync = (fd,...args) => { if(fd===0 && !changed) { changed=true; fs.unlinkSync(process.env.BALLIN_TEST_CONFIG_PATH); }
      return readSync(fd,...args); };`);
    const result = run('y\n'); assert.equal(result.status, 1);
    assert.isFalse(fs.existsSync(file)); assert.notInclude(result.stdout, 'Keep Ballin');
  });
  it('restores explicit remote NVM choices over pending defaults without exporting intent', () => {
    const local = { ...structuredClone(defaults), _setup: { unreviewedNvm: true } };
    const restored = restorePortablePreferences(local, local, { update: { nvm: false } });
    assert.notProperty(restored, '_setup'); assert.equal(restored.update.nvm, 'false');
    assert.notProperty(projectPortablePreferences(local), '_setup');
    const explicit = { ...local }; delete explicit._setup;
    assert.equal(restorePortablePreferences(explicit, explicit, { update: { nvm: true } }).update.nvm, 'false');
  });
  for (const input of ['', 'y', 'n\n', 'n\ny']) {
    it(`preserves pending and earlier confirmed choices on EOF ${JSON.stringify(input)}`, () => {
      const result = run(input); assert.equal(result.status, 0, result.stderr);
      assert.equal(read().update.npm, 'false'); assert.equal(read().update.selfUpdate, 'true');
      assert.include(result.stdout, 'Review cancelled'); assert.notInclude(result.stdout, 'Setup complete.');
      assert.equal(result.stdout.split('Run `ballin backup setup`').length - 1, 1);
    });
  }
  it('reprompts invalid answers and saves only complete decisions', () => {
    const result = run('private invalid answer\n YeS \nno\n\n\n\n');
    assert.equal(result.status, 0, result.stderr); assert.include(result.stdout, 'Please enter yes or no.');
    assert.notInclude(result.stdout, 'private invalid answer'); assert.equal(read().update.npm, 'true'); assert.equal(read().update.selfUpdate, 'false');
  });
  it('rereads config before every save so concurrent unrelated edits survive', () => {
    fs.appendFileSync(guard, `const readSync = fs.readSync; let changed = false;
      fs.readSync = (fd,...args) => { if(fd===0 && !changed) { changed=true; const f=process.env.BALLIN_TEST_CONFIG_PATH;
      const c=JSON.parse(read(f,'utf8')); c.concurrent='retained'; fs.writeFileSync(f,JSON.stringify(c)); } return readSync(fd,...args); };`);
    assert.equal(run('\n'.repeat(5)).status, 0); assert.equal(read().concurrent, 'retained');
  });
  it('stops on save failure before later prompts, with recovery last and no backup-specific error', () => {
    fs.appendFileSync(guard, "fs.renameSync = () => { throw Error('Synthetic save failure'); };\n");
    const before = fs.readFileSync(file, 'utf8'); const result = run('y\n'.repeat(6));
    assert.equal(result.status, 1); assert.notInclude(result.stdout, 'Keep Ballin');
    assert.notInclude(result.stderr, 'save backup configuration'); assert.include(result.stderr, 'run `ballin setup` again.');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) it(`preserves current choice on ${signal}`, async () => {
    const child = spawn(process.execPath, [ballin, 'setup'], { env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: file }) });
    let text = ''; child.stdout.on('data', (chunk: Buffer) => { text += chunk; if (text.includes('Keep Ballin')) child.kill(signal); });
    child.stdin.write('y\n');
    const ended = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code: number, end: string | null) => resolve(end)); });
    assert.equal(ended, signal); assert.equal(read().update.npm, 'true'); assert.equal(read().update.selfUpdate, 'true');
  });
  for (const contents of ['{', '[]', '{"update":[]}']) it(`preserves malformed config ${contents}`, () => {
    fs.writeFileSync(file, contents); assert.equal(run().status, 1); assert.equal(fs.readFileSync(file, 'utf8'), contents);
  });
  it('does not replace a dangling config link', () => {
    fs.rmSync(file); const missing = path.join(root, 'missing'); fs.symlinkSync(missing, file);
    assert.equal(run().status, 1); assert.equal(fs.readlinkSync(file), missing); assert.isFalse(fs.existsSync(missing));
  });
  it('creates a missing standalone config privately and retains unreviewed NVM intent', () => {
    fs.rmSync(file);
    const result = run('\n'.repeat(5)); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(read().update.nvm, 'false'); assert.isTrue(read()._setup.unreviewedNvm);
    assert.include(result.stdout, 'Created config:'); assert.include(result.stdout, 'Setup complete.');
  });
  it('reports config creation failure without replacing missing parent directories', () => {
    const missing = path.join(root, 'absent/config.json');
    const result = run('', { BALLIN_TEST_CONFIG_PATH: missing });
    assert.equal(result.status, 1); assert.include(result.stderr, 'Unable to create local config.');
    assert.notInclude(result.stderr, 'config reset'); assert.isFalse(fs.existsSync(path.dirname(missing)));
  });
  it('keeps config access failures distinct from invalid-content recovery', () => {
    const before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(guard, `const stat = fs.lstatSync;
      fs.lstatSync = (entry,...args) => { if(entry === process.env.BALLIN_TEST_CONFIG_PATH) throw Object.assign(Error('private details'),{code:'EACCES'});
      return stat(entry,...args); };`);
    const result = run(); assert.equal(result.status, 1);
    assert.include(result.stderr, 'Check local config access and structure.'); assert.notInclude(result.stderr, 'config reset');
    assert.notInclude(result.stderr, 'private details'); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  it('keeps help offline and rejects extra setup arguments', () => {
    fs.writeFileSync(file, '{'); const help = run('', {}, ['setup', '--help']);
    assert.equal(help.status, 0); assert.include(help.stdout, 'update and analytics');
    assert.equal(run('', {}, ['setup', 'extra']).status, 2);
  });
});
