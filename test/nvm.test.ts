const fs = require('fs');
const path = require('path');
const os = require('os');
const { testChildEnvironment, withEnvironment } = require('./helpers/environment.ts');
const { discoverNvm, followsLtsAlias, inspectNvm } = require('../commands/nvm.ts');

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
  it('handles missing installations, invalid directories, and failed brew discovery', () => {
    assert.isNull(discoverNvm(env({ PATH: root, NVM_DIR: 'relative' })));
    fs.writeFileSync(path.join(root, 'brew'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    assert.isNull(discoverNvm(env({ PATH: root })));
    fs.writeFileSync(path.join(root, 'brew'), '#!/bin/sh\nprintf relative\n', { mode: 0o700 });
    assert.isNull(discoverNvm(env({ PATH: root })));
    assert.isFalse(inspectNvm(env({ PATH: root })).loadable);
  });
  it('propagates NVM inspection interruption', () => {
    source('kill -INT $$\n');
    assert.throws(() => withEnvironment({}, () => inspectNvm(env())), 'Interrupted');
  });
});
