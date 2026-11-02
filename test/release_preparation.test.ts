const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

describe('release preparation', () => {
  let root: string;
  const files = ['release.json', 'installer-contract.json', 'package.json', 'install.sh', 'quickstart.sh', 'scripts/revision-bootstrap.sh', 'scripts/prepare-release.cjs', 'README.md', 'docs/quickstart.md', 'docs/installation.md'];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-release-test-'));
    for (const file of files) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.resolve(__dirname, '..', file), target); }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts/prepare-release.cjs'), ...args], { encoding: 'utf8', env: { HOME: root, PATH: '' } });
  it('synchronizes embedded identity and documented URLs without Git or publishing tools', () => {
    const r = run('1.2.3', 'stable'); assert.equal(r.status, 0, r.stderr);
    for (const file of ['install.sh', 'quickstart.sh']) assert.include(fs.readFileSync(path.join(root, file), 'utf8'), "ballin_embedded_version='1.2.3'");
    for (const file of ['README.md', 'docs/quickstart.md', 'docs/installation.md']) assert.include(fs.readFileSync(path.join(root, file), 'utf8'), '/v1.2.3/');
    assert.equal(run('--check').status, 0); assert.isFalse(fs.existsSync(path.join(root, '.git')));
  });
  it('detects stale generated blocks and derives minimum Node from engines', () => {
    const file = path.join(root, 'package.json'); const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.engines.node = '>=26.2.1'; fs.writeFileSync(file, JSON.stringify(data));
    assert.notEqual(run('--check').status, 0); assert.equal(run().status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'installer-contract.json'), 'utf8')).minimumNode, '26.2.1');
    assert.equal(run('--check').status, 0);
  });
  for (const version of ['1.0.0-rc.1', 'v1.0.0', '01.0.0', '1000.0.0']) it(`refuses unsupported release ${version}`, () => {
    const before = fs.readFileSync(path.join(root, 'release.json'), 'utf8'); assert.notEqual(run(version, 'stable').status, 0); assert.equal(fs.readFileSync(path.join(root, 'release.json'), 'utf8'), before);
  });
});
