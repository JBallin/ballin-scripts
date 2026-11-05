const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

describe('release preparation', () => {
  let root: string;
  const files = ['package.json', 'package-lock.json', 'install.sh', 'quickstart.sh', 'scripts/revision-bootstrap.sh', 'scripts/prepare-release.cjs', 'README.md', 'docs/quickstart.md', 'docs/installation.md'];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-release-test-'));
    for (const file of files) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.resolve(__dirname, '..', file), target); }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts/prepare-release.cjs'), ...args], { encoding: 'utf8', env: { HOME: root, PATH: '' } });
  const packageData = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  it('synchronizes package identity, lock, embedded versions and URLs without Git or publishing tools', () => {
    const r = run('1.2.3'); assert.equal(r.status, 0, r.stderr);
    assert.equal(packageData().version, '1.2.3');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '1.2.3'); assert.equal(lock.packages[''].version, '1.2.3');
    for (const file of ['install.sh', 'quickstart.sh']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.include(text, "ballin_embedded_version='1.2.3'"); assert.notInclude(text, 'ballin_default_track=');
      const syntax = spawnSync('/bin/bash', ['-n', path.join(root, file)], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    for (const file of ['README.md', 'docs/quickstart.md', 'docs/installation.md']) assert.include(fs.readFileSync(path.join(root, file), 'utf8'), '/v1.2.3/');
    assert.equal(run('--check').status, 0); assert.isFalse(fs.existsSync(path.join(root, '.git')));
    for (const file of ['release.json', 'installer-contract.json']) assert.isFalse(fs.existsSync(path.join(root, file)));
  });
  it('copies shell replacement metacharacters literally and preserves the entrypoint body', () => {
    const file = path.join(root, 'install.sh');
    const source = fs.readFileSync(file, 'utf8');
    const tail = source.slice(source.indexOf('# END RELEASE BOOTSTRAP') + '# END RELEASE BOOTSTRAP'.length);
    assert.equal(run().status, 0);
    const generated = fs.readFileSync(file, 'utf8');
    assert.equal(generated.slice(generated.indexOf('# END RELEASE BOOTSTRAP') + '# END RELEASE BOOTSTRAP'.length), tail);
    assert.equal(generated.split('# END RELEASE BOOTSTRAP').length, 2);
    assert.include(generated, fs.readFileSync(path.join(root, 'scripts/revision-bootstrap.sh'), 'utf8').replace(/^#![^\n]*\n/, '').trimEnd());
    assert.equal(run('--check').status, 0);
  });
  it('preserves explicitly opted-in main instructions until a version is prepared', () => {
    const command = 'BALLIN_UPDATE_TRACK=main /bin/bash -c "$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)"';
    fs.writeFileSync(path.join(root, 'README.md'), command + '\n');
    assert.equal(run().status, 0); assert.equal(run('--check').status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), command + '\n');
    assert.equal(run('1.2.3').status, 0); assert.equal(run('--check').status, 0);
    const released = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.notInclude(released, 'BALLIN_UPDATE_TRACK'); assert.include(released, '/v1.2.3/install.sh');
  });
  it('detects stale generated blocks and derives minimum Node only from engines', () => {
    assert.equal(run().status, 0);
    const file = path.join(root, 'package.json'); const data = packageData(); data.engines.node = '>=26.2.1'; fs.writeFileSync(file, JSON.stringify(data));
    assert.notEqual(run('--check').status, 0); const updated = run(); assert.equal(updated.status, 0, updated.stderr);
    assert.include(updated.stdout, 'Node >=26.2.1'); assert.equal(run('--check').status, 0);
    assert.deepEqual(packageData().ballin, { installerProtocol: 2 });
  });
  it('detects root and package lock version drift', () => {
    assert.equal(run().status, 0);
    const file = path.join(root, 'package-lock.json'), lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    lock.version = '2.0.0'; fs.writeFileSync(file, JSON.stringify(lock));
    assert.notEqual(run('--check').status, 0); assert.equal(run().status, 0); assert.equal(run('--check').status, 0);
    lock.version = packageData().version; lock.packages[''].version = '3.0.0'; fs.writeFileSync(file, JSON.stringify(lock));
    assert.notEqual(run('--check').status, 0);
  });
  for (const invalid of ['2', 1, null]) it(`refuses invalid installer protocol ${JSON.stringify(invalid)}`, () => {
    const file = path.join(root, 'package.json'), data = packageData(); data.ballin.installerProtocol = invalid; fs.writeFileSync(file, JSON.stringify(data));
    const before = fs.readFileSync(file, 'utf8'); assert.notEqual(run('1.2.3').status, 0); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  for (const engine of ['>=24', '>=024.12', '^24.12.0', '>=24.12.0 <30', null]) it(`refuses unsupported engine ${JSON.stringify(engine)}`, () => {
    const file = path.join(root, 'package.json'), data = packageData(); data.engines.node = engine; fs.writeFileSync(file, JSON.stringify(data));
    const before = fs.readFileSync(file, 'utf8'); assert.notEqual(run().status, 0); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  for (const args of [['1.0.0-rc.1'], ['v1.0.0'], ['01.0.0'], ['1000.0.0'], ['1.0.0', 'stable'], ['--check', 'extra']]) it(`refuses unsupported release arguments ${JSON.stringify(args)}`, () => {
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8'); assert.notEqual(run(...args).status, 0); assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  });
});
