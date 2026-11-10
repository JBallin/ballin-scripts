const fs = require('fs');
const path = require('path');
const os = require('os');
const { testChildEnvironment, withEnvironment } = require('./helpers/environment.ts');
const { discoverNvm, followsLtsAlias, inspectNvm, trustedNvmSource, trustedNvmDirectory, untrustedNvmEntry } = require('../commands/nvm.ts');

describe('read-only NVM discovery and eligibility', () => {
  let root: string;
  let directory: string;
  const env = (extra: NodeJS.ProcessEnv = {}) => testChildEnvironment({ HOME: root, PATH: '/usr/bin:/bin', NVM_DIR: directory, ...extra });
  const alias = (name: string, value: string) => { const file = path.join(directory, 'alias', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const source = (contents = 'nvm() { [ "$1" = version ] && printf "v26.13.0\\n"; }\n') => fs.writeFileSync(path.join(directory, 'nvm.sh'), contents);
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-nvm-test-'))); directory = path.join(root, '.nvm'); fs.mkdirSync(directory);
    fs.mkdirSync(path.join(directory, 'versions/node/v26.13.0/bin'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'versions/node/v26.13.0/bin/node'), 'not executed');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [value, eligible] of [['lts/*', true], ['v26.13.0', false], ['lts/krypton', false], ['node', false], ['stable', false], ['../outside', false], ['.', false], ['', false]] as const) {
    it(`recognizes semantic default ${value}`, () => {
      source(); alias('default', value); assert.equal(followsLtsAlias(directory), eligible);
      const result = inspectNvm(env()); assert.isTrue(result.loadable); assert.equal(result.followsLts, eligible);
    });
  }
  it('follows dotted alias indirection and rejects cycles and missing/unreadable targets', () => {
    alias('default', 'work.lts'); alias('work.lts', 'lts/*'); assert.isTrue(followsLtsAlias(directory));
    alias('work.lts', 'default'); assert.isFalse(followsLtsAlias(directory));
    alias('work.lts', 'missing'); assert.isFalse(followsLtsAlias(directory));
    fs.rmSync(path.join(directory, 'alias/work.lts')); fs.symlinkSync('/outside', path.join(directory, 'alias/work.lts'));
    assert.isFalse(followsLtsAlias(directory));
  });
  it('bounds alias depth and metadata copy size', () => {
    for (let index = 0; index < 41; index += 1) alias(index ? `a${index}` : 'default', `a${index + 1}`);
    alias('a42', 'lts/*'); assert.isFalse(followsLtsAlias(directory));
    source(); alias('large', 'x'.repeat(4097)); fs.mkdirSync(path.join(directory, 'alias/deep/tree'), { recursive: true }); alias('deep/tree/ignored', 'lts/*');
    assert.isTrue(inspectNvm(env()).loadable);
  });
  for (const contents of ['return 1\n', ':\n', 'nvm() { return 3; }\n']) it(`requires a successfully loaded function and resolved default: ${contents.trim()}`, () => {
    source(contents); alias('default', 'lts/*'); assert.isFalse(inspectNvm(env()).followsLts);
  });
  it('contains incidental query writes in a disposable HOME/NVM_DIR and never executes personal startup', () => {
    alias('default', 'lts/*');
    fs.writeFileSync(path.join(root, '.bashrc'), 'touch "$HOME/UNSAFE"');
    source('printf temporary > "$NVM_DIR/probe-write"\nnvm() { printf query > "$HOME/query-write"; printf "v26.13.0\\n"; }\n');
    const before = fs.readdirSync(directory); const originalPath = env().PATH;
    const result = inspectNvm(env()); assert.isTrue(result.followsLts);
    assert.deepEqual(fs.readdirSync(directory), before); assert.equal(env().PATH, originalPath);
    assert.isFalse(fs.existsSync(path.join(root, 'query-write'))); assert.isFalse(fs.existsSync(path.join(root, 'UNSAFE')));
  });
  it('keeps inspection failure ineligible, allowing an enabled preference to be reviewed', () => {
    source(); alias('default', 'lts/*'); const read = fs.readdirSync;
    fs.readdirSync = (file: string, ...args: unknown[]) => {
      if (file === path.join(directory, 'alias')) throw Object.assign(Error('unreadable metadata'), { code: 'EACCES' });
      return read(file, ...args);
    };
    try { assert.isFalse(inspectNvm(env()).followsLts); } finally { fs.readdirSync = read; }
  });
  it('keeps an unreadable discovery source ineligible without exposing its error', () => {
    source(); const read = fs.readFileSync;
    fs.readFileSync = (file: string, ...args: unknown[]) => {
      if (file === path.join(directory, 'nvm.sh')) throw Object.assign(Error('private source details'), { code: 'EACCES' });
      return read(file, ...args);
    };
    try { assert.deepEqual(inspectNvm(env()), { installation: null, loadable: false, followsLts: false }); }
    finally { fs.readFileSync = read; }
  });
  it('finds conventional and XDG sources without a supplied directory', () => {
    source(); assert.equal(discoverNvm(env({ NVM_DIR: undefined })).directory, directory);
    const xdg = path.join(root, 'config'); fs.mkdirSync(path.join(xdg, 'nvm'), { recursive: true });
    fs.copyFileSync(path.join(directory, 'nvm.sh'), path.join(xdg, 'nvm/nvm.sh'));
    assert.equal(discoverNvm(env({ NVM_DIR: undefined, XDG_CONFIG_HOME: xdg })).directory, path.join(xdg, 'nvm'));
  });
  it('does not query Brew in experimental direct installation mode', () => {
    const marker = path.join(root, 'brew-called');
    fs.writeFileSync(path.join(root, 'brew'), `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o700 });
    assert.isNull(discoverNvm({ ...env(), PATH: root, BALLIN_EXPERIMENT_INSTALL_OWNER: 'direct' }));
    assert.isFalse(fs.existsSync(marker));
  });
  it('resolves a verified Homebrew libexec without executing its mutating wrapper', () => {
    const prefix = path.join(root, 'brew'); const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
    fs.mkdirSync(path.join(prefix, 'opt/nvm/libexec'), { recursive: true });
    const script = path.join(prefix, 'opt/nvm/libexec/nvm.sh'); fs.writeFileSync(script, 'nvm() { return 3; }\n');
    fs.writeFileSync(path.join(prefix, 'opt/nvm/nvm.sh'), 'touch "$HOME/UNSAFE"\n# libexec/nvm.sh\n');
    fs.copyFileSync(path.join(prefix, 'opt/nvm/nvm.sh'), path.join(directory, 'nvm.sh'));
    fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/sh\nprintf '%s\\n' '${prefix}'\n`, { mode: 0o700 });
    const found = discoverNvm(env({ PATH: `${tools}:/usr/bin:/bin` }));
    assert.equal(found.source, script); assert.equal(found.completion, path.join(prefix, 'opt/nvm/etc/bash_completion.d/nvm'));
    assert.isFalse(fs.existsSync(path.join(root, 'UNSAFE')));
  });
  it('loads a linked Homebrew installation through its stable libexec path', () => {
    const prefix = path.join(root, 'brew'); const formula = path.join(prefix, 'Cellar/nvm/0.40.8');
    fs.mkdirSync(path.join(formula, 'libexec'), { recursive: true }); fs.mkdirSync(path.join(prefix, 'opt'));
    const script = path.join(formula, 'libexec/nvm.sh');
    fs.writeFileSync(script, 'nvm() { printf "v26.13.0\\n"; }\n');
    fs.symlinkSync(formula, path.join(prefix, 'opt/nvm'));
    fs.symlinkSync(script, path.join(directory, 'nvm.sh')); alias('default', 'lts/*');
    const stable = path.join(prefix, 'opt/nvm/libexec/nvm.sh');
    assert.equal(discoverNvm(env()).source, stable); assert.equal(discoverNvm(env()).method, 'homebrew');
    assert.equal(discoverNvm(env()).completion, path.join(prefix, 'opt/nvm/etc/bash_completion.d/nvm'));
    assert.isTrue(inspectNvm(env()).followsLts); assert.equal(fs.readlinkSync(path.join(directory, 'nvm.sh')), script);
  });
  if (process.platform === 'darwin') for (const group of [80, process.getgid!()]) {
    for (const mode of [0o775, 0o777]) it(`checks Homebrew group ${group} mode ${mode.toString(8)} without trusting ordinary peers`, () => {
      const prefix = path.join(root, 'brew'); const formula = path.join(prefix, 'Cellar/nvm/0.40.8');
      fs.mkdirSync(path.join(formula, 'libexec'), { recursive: true }); fs.mkdirSync(path.join(prefix, 'opt'));
      fs.mkdirSync(path.join(prefix, 'Library/Homebrew'), { recursive: true }); fs.writeFileSync(path.join(prefix, 'Library/Homebrew/brew.sh'), '# fixture');
      const script = path.join(formula, 'libexec/nvm.sh'); fs.writeFileSync(script, 'nvm() { printf "v26.13.0\\n"; }\n');
      fs.symlinkSync(formula, path.join(prefix, 'opt/nvm')); fs.symlinkSync(script, path.join(directory, 'nvm.sh'));
      for (const name of ['opt', 'Cellar']) { fs.chownSync(path.join(prefix, name), process.getuid!(), group); fs.chmodSync(path.join(prefix, name), mode); }
      assert.equal(inspectNvm(env()).loadable, group === 80 && mode === 0o775);
      fs.unlinkSync(path.join(prefix, 'Library/Homebrew/brew.sh'));
      assert.isFalse(trustedNvmSource(script), 'a Homebrew-looking path alone does not establish the route');
    });
  }
  for (const unsafe of ['none', 'root', 'versions', 'node', 'linked node', 'nested link', 'safe nested link']) {
    it(`validates the NVM working tree before update (unsafe: ${unsafe})`, () => {
      source(); const node = path.join(directory, 'versions/node/v26.13.0/bin/node');
      if (unsafe === 'root') fs.chmodSync(directory, 0o777);
      if (unsafe === 'versions') fs.chmodSync(path.join(directory, 'versions'), 0o770);
      if (unsafe === 'node') fs.chmodSync(node, 0o666);
      if (unsafe === 'linked node') { const outside = path.join(root, 'outside-node'); fs.renameSync(node, outside); fs.chmodSync(outside, 0o777); fs.symlinkSync(outside, node); }
      if (unsafe.includes('nested link')) {
        const versions = path.join(directory, 'versions'); const external = path.join(root, 'external-versions');
        fs.renameSync(versions, external); fs.symlinkSync(external, versions);
        const parent = path.join(root, 'outside'); fs.mkdirSync(parent);
        const target = path.join(parent, 'node'); fs.renameSync(node, target); fs.symlinkSync(target, node);
        if (unsafe === 'nested link') fs.chmodSync(parent, 0o777);
      }
      assert.equal(trustedNvmDirectory(directory, path.join(directory, 'nvm.sh')), unsafe === 'none' || unsafe === 'safe nested link');
      const expected: Record<string, { kind: string; path: string } | null> = {
        none: null, 'safe nested link': null,
        root: { kind: 'directory', path: directory },
        versions: { kind: 'entry', path: path.join(directory, 'versions') },
        node: { kind: 'entry', path: node },
        'linked node': { kind: 'entry', path: node },
        'nested link': { kind: 'link', path: node },
      };
      assert.deepEqual(untrustedNvmEntry(directory, path.join(directory, 'nvm.sh')), expected[unsafe]);
    });
  }
  it('reports the first unsafe entry even when its name contains newlines', () => {
    source(); const name = path.join(directory, 'line\nbreak'); fs.writeFileSync(name, 'fixture'); fs.chmodSync(name, 0o666);
    assert.deepEqual(untrustedNvmEntry(directory, path.join(directory, 'nvm.sh')), { kind: 'entry', path: name });
  });
  if (process.platform === 'darwin') for (const target of ['.cache', '.cache/archive']) {
    it(`rejects write-granting working-tree ACLs on ${target}`, () => {
      source(); fs.mkdirSync(path.join(directory, '.cache')); fs.writeFileSync(path.join(directory, '.cache/archive'), 'fixture');
      assert.equal(require('child_process').spawnSync('/bin/chmod', ['+a', 'everyone allow write', path.join(directory, target)]).status, 0);
      assert.isFalse(trustedNvmDirectory(directory, path.join(directory, 'nvm.sh')));
    });
  }
  it('handles missing installations, invalid directories, and failed brew discovery', () => {
    assert.isNull(discoverNvm(env({ PATH: root, NVM_DIR: 'relative' })));
    fs.writeFileSync(path.join(root, 'brew'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    assert.isNull(discoverNvm(env({ PATH: root })));
    fs.writeFileSync(path.join(root, 'brew'), '#!/bin/sh\nprintf relative\n', { mode: 0o700 });
    assert.isNull(discoverNvm(env({ PATH: root })));
    assert.isFalse(inspectNvm(env({ PATH: root })).loadable);
  });
  for (const unsafe of ['source', 'parent', 'target parent', 'link parent', 'intermediate symlink']) {
    it(`never executes an unsafe ${unsafe} during discovery`, () => {
      const marker = path.join(root, 'outside-probe');
      source(`printf compromised > '${marker}'\nnvm() { printf 'v26.13.0\\n'; }\n`);
      alias('default', 'lts/*');
      let selected = directory;
      if (unsafe === 'source') fs.chmodSync(path.join(directory, 'nvm.sh'), 0o666);
      if (unsafe === 'parent') fs.chmodSync(directory, 0o777);
      if (unsafe === 'target parent') {
        const target = path.join(root, 'writable'); fs.mkdirSync(target, { mode: 0o700 });
        fs.renameSync(path.join(directory, 'nvm.sh'), path.join(target, 'nvm.sh'));
        fs.symlinkSync('../writable/nvm.sh', path.join(directory, 'nvm.sh')); fs.chmodSync(target, 0o777);
      }
      if (unsafe === 'link parent' || unsafe === 'intermediate symlink') {
        const parent = path.join(root, 'writable'); fs.mkdirSync(parent, { mode: 0o700 });
        fs.symlinkSync(directory, path.join(parent, 'linked')); fs.chmodSync(parent, 0o777);
        selected = path.join(parent, 'linked');
        if (unsafe === 'intermediate symlink') {
          fs.symlinkSync(selected, path.join(root, 'outer')); selected = path.join(root, 'outer');
        }
      }
      const result = inspectNvm(env({ NVM_DIR: selected }));
      assert.isFalse(fs.existsSync(marker), 'discovery must not execute an outside-marker payload');
      assert.isFalse(result.loadable);
    });
  }
  it('rejects an unsafe inherited XDG source', () => {
    source(); fs.chmodSync(path.join(directory, 'nvm.sh'), 0o664);
    fs.renameSync(directory, path.join(root, 'nvm'));
    assert.isFalse(inspectNvm(env({ NVM_DIR: undefined, XDG_CONFIG_HOME: root })).loadable);
  });
  if (process.platform === 'darwin') for (const linked of [false, true]) it(`rejects write-granting macOS ACLs on ${linked ? 'symlinks' : 'files'} even without writable mode bits`, () => {
    source();
    const file = path.join(directory, 'nvm.sh');
    if (linked) { fs.renameSync(file, path.join(root, 'source.sh')); fs.symlinkSync(path.join(root, 'source.sh'), file); }
    const result = require('child_process').spawnSync('/bin/chmod', ['-h', '+a', `everyone allow ${linked ? 'delete' : 'write'}`, file]);
    assert.equal(result.status, 0);
    assert.isFalse(trustedNvmSource(file));
    assert.isFalse(inspectNvm(env()).loadable);
  });
  for (const entry of ['source', 'parent', 'symlink', 'target parent']) it(`rejects a foreign-owned ${entry} even with read-only modes`, () => {
    const marker = path.join(root, 'outside-probe');
    source(`printf compromised > '${marker}'\nnvm() { return 3; }\n`);
    let foreign = entry === 'parent' ? directory : path.join(directory, 'nvm.sh');
    if (entry === 'symlink' || entry === 'target parent') {
      const target = path.join(root, 'target'); fs.mkdirSync(target);
      fs.renameSync(path.join(directory, 'nvm.sh'), path.join(target, 'nvm.sh'));
      fs.symlinkSync(path.join(target, 'nvm.sh'), path.join(directory, 'nvm.sh'));
      if (entry === 'target parent') foreign = target;
    }
    const stat = fs.lstatSync;
    fs.lstatSync = (file: string, ...args: unknown[]) => {
      const value = stat(file, ...args);
      if (file === foreign) value.uid = 123456;
      return value;
    };
    try {
      assert.isFalse(inspectNvm(env()).loadable);
      assert.isFalse(fs.existsSync(marker));
    } finally { fs.lstatSync = stat; }
  });
  it('accepts a trusted relative symlink but rejects cycles and traversal through an unsafe directory', () => {
    source(); const link = path.join(root, 'linked.sh'); fs.symlinkSync('.nvm/nvm.sh', link);
    assert.isTrue(trustedNvmSource(link));
    const unsafe = path.join(root, 'writable'); fs.mkdirSync(unsafe); fs.chmodSync(unsafe, 0o777);
    assert.isFalse(trustedNvmSource(`${unsafe}/../.nvm/nvm.sh`));
    fs.unlinkSync(link); fs.symlinkSync('linked.sh', link); assert.isFalse(trustedNvmSource(link));
  });
  it('fails closed for unavailable ownership and non-file paths, while preserving lexical traversal', () => {
    source();
    assert.isFalse(trustedNvmSource('relative/nvm.sh'));
    assert.isFalse(trustedNvmSource(directory));
    assert.isFalse(trustedNvmSource(`${directory}/nvm.sh/child`));
    assert.isFalse(trustedNvmSource(path.join(root, 'missing')));
    assert.isTrue(trustedNvmSource(`${directory}/../.nvm/./nvm.sh`));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')!;
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try { assert.isFalse(trustedNvmSource(path.join(directory, 'nvm.sh'))); }
    finally { Object.defineProperty(process, 'getuid', descriptor); }
  });
  for (const outcome of ['failure', 'missing output', 'interrupted', 'write ACL', 'read ACL']) it(`handles ACL inspection ${outcome} without sourcing NVM`, () => {
    source();
    const helpers = require('../commands/commandHelpers.ts');
    const original = helpers.runCommand;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const modulePath = require.resolve('../commands/nvm.ts'); const cached = require.cache[modulePath];
    helpers.runCommand = () => ({ status: outcome === 'failure' ? 1 : outcome === 'interrupted' ? null : 0,
      signal: outcome === 'interrupted' ? 'SIGINT' : null,
      stdout: outcome === 'write ACL' ? ' 0: group:everyone allow write' : outcome === 'read ACL' ? ' 0: group:everyone allow read' : undefined });
    delete require.cache[modulePath];
    try {
      const fresh = require('../commands/nvm.ts');
      if (outcome === 'interrupted') assert.throws(() => fresh.trustedNvmSource(path.join(directory, 'nvm.sh')), 'Interrupted');
      else assert.equal(fresh.trustedNvmSource(path.join(directory, 'nvm.sh')), outcome === 'read ACL');
    } finally { helpers.runCommand = original; require.cache[modulePath] = cached; Object.defineProperty(process, 'platform', platform); }
  });
  it('propagates NVM inspection interruption', () => {
    source('kill -INT $$\n');
    assert.throws(() => withEnvironment({}, () => inspectNvm(env())), 'Interrupted');
  });
});
