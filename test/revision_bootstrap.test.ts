const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('candidate revision bootstrap', () => {
  let root: string;
  const sha = 'a'.repeat(40);
  const shared = fs.readFileSync(path.join(__dirname, '../scripts/revision-bootstrap.sh'), 'utf8');
  const candidate = `#!/bin/bash\n{\nballin_entry=install.sh\nballin_default_track=main\nballin_embedded_version=1.0.0\n${shared}\nballin_select "$@" || exit $?\nprintf '%s\\n' "$ballin_kind:$ballin_value:$ballin_sha:$ballin_minimum"\nIFS= read -r answer\nprintf 'answer:%s\\n' "$answer"\n}\n`;
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-bootstrap-test-'));
    write('entry.sh', candidate); write('selected.sh', candidate);
    write('contract.json', { protocol: 1, minimumNode: '24.12.0' });
    write('ref.json', { object: { sha, type: 'commit' } });
    write('release.json', { tag_name: 'v1.0.0', draft: false, prerelease: false, id: 123, published_at: '2026-01-01T00:00:00Z' });
    fs.writeFileSync(path.join(root, 'curl'), `#!${process.execPath}\nconst fs=require('fs'),p=require('path');const a=process.argv.slice(2),u=a.find(v=>v.startsWith('https://')),out=a[a.indexOf('-o')+1];fs.appendFileSync(p.join(process.env.HOME,'requests'),u+'\\n');let f;if(u.includes('/releases/'))f='release.json';else if(u.includes('/git/ref/'))f='ref.json';else if(u.endsWith('/installer-contract.json'))f='contract.json';else if(u.endsWith('/install.sh'))f='selected.sh';else process.exit(97);if(process.env.FIXTURE_HTTP){process.stdout.write(process.env.FIXTURE_HTTP);process.exit(0);}fs.copyFileSync(p.join(process.env.HOME,f),out);process.stdout.write('200');\n`, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', [path.join(root, 'entry.sh'), ...args], {
    encoding: 'utf8', input: 'kept stdin\n', env: testChildEnvironment({ HOME: root, PATH: `${root}:${path.dirname(process.execPath)}:/usr/bin:/bin`, ...env }), timeout: 10000,
  });
  for (const [args, kind, value] of [ [[], 'branch', 'main'], [['--sha', sha], 'sha', sha], [['--branch', 'feature/test'], 'branch', 'feature/test'], [['--version', 'v1.0.0'], 'release', 'v1.0.0'] ] as [string[], string, string][]) {
    it(`resolves once and preserves stdin for ${kind} ${value}`, () => {
      const result = run(args, { BALLIN_UPDATE_TRACK: 'main' });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, `${kind}:${value}:${sha}:24.12.0`);
      assert.include(result.stdout, 'answer:kept stdin');
      const requests = fs.readFileSync(path.join(root, 'requests'), 'utf8').trim().split('\n');
      assert.equal(requests.filter((u: string) => u.endsWith('/install.sh')).length, 1);
      assert.include(requests[requests.length - 1], `/${sha}/install.sh`);
      assert.isAtMost(requests.filter((u: string) => u.includes('/git/ref/')).length, 1);
    });
  }
  for (const code of ['404', '401', '403', '429', '500']) it(`fails closed on HTTP ${code}`, () => {
    const r = run(['--version', 'v1.0.0'], { FIXTURE_HTTP: code }); assert.notEqual(r.status, 0); assert.notInclude(r.stdout, 'answer:');
    assert.notInclude(fs.readFileSync(path.join(root, 'requests'), 'utf8'), '/heads/main');
    assert.include(r.stderr, code === '404' ? 'No published release' : code === '500' ? 'request failed' : 'authentication or rate limit');
  });
  it('refuses an unsupported contract before downloading selected executable code', () => {
    write('contract.json', { protocol: 2, minimumNode: '24.12.0' });
    const r = run(['--sha', sha]); assert.notEqual(r.status, 0); assert.include(r.stderr, 'unsupported installer contract');
    assert.notInclude(fs.readFileSync(path.join(root, 'requests'), 'utf8'), '/install.sh');
  });
  it('refuses incompatible Node before selected executable code', () => {
    write('contract.json', { protocol: 1, minimumNode: '999.0.0' });
    const r = run(['--sha', sha]); assert.notEqual(r.status, 0); assert.include(r.stderr, 'requires Node.js 999.0.0');
    assert.notInclude(fs.readFileSync(path.join(root, 'requests'), 'utf8'), '/install.sh');
  });
  it('uses embedded release after activation, not latest release or main', () => {
    write('entry.sh', candidate.replace('ballin_default_track=main', 'ballin_default_track=stable'));
    const r = run([]); assert.equal(r.status, 0, r.stderr); assert.include(r.stdout, 'release:v1.0.0:');
    const requests = fs.readFileSync(path.join(root, 'requests'), 'utf8'); assert.include(requests, '/releases/tags/v1.0.0'); assert.notInclude(requests, '/latest');
  });
  it('rejects malformed API data without a fallback', () => {
    write('ref.json', { object: { sha: 'main', type: 'commit' } });
    const r = run(['--branch', 'main']); assert.notEqual(r.status, 0); assert.include(r.stderr, 'invalid commit');
  });
  it('keeps the original SHA when a branch moves after resolution', () => {
    const curl = fs.readFileSync(path.join(root, 'curl'), 'utf8');
    write('curl', curl.replace("fs.copyFileSync(p.join(process.env.HOME,f),out);", "fs.copyFileSync(p.join(process.env.HOME,f),out);if(f==='ref.json')fs.writeFileSync(p.join(process.env.HOME,f),JSON.stringify({object:{sha:'b'.repeat(40),type:'commit'}}));"));
    const r = run(['--branch', 'main']); assert.equal(r.status, 0, r.stderr); assert.include(r.stdout, `branch:main:${sha}:`);
    const requests = fs.readFileSync(path.join(root, 'requests'), 'utf8'); assert.notInclude(requests, 'b'.repeat(40));
    assert.equal(requests.split('/git/ref/heads/main').length - 1, 1);
  });
  it('peels an annotated release tag before downloading the selected entrypoint', () => {
    write('ref.json', { object: { sha: 'b'.repeat(40), type: 'tag' } });
    write('annotated.json', { object: { sha, type: 'commit' } });
    write('curl', fs.readFileSync(path.join(root, 'curl'), 'utf8').replace("else if(u.includes('/git/ref/'))", "else if(u.includes('/git/tags/'))f='annotated.json';else if(u.includes('/git/ref/'))"));
    const r = run(['--version', 'v1.0.0']); assert.equal(r.status, 0, r.stderr); assert.include(r.stdout, `release:v1.0.0:${sha}:`);
    assert.include(fs.readFileSync(path.join(root, 'requests'), 'utf8'), `/git/tags/${'b'.repeat(40)}`);
  });
  it('bounds incompatible entrypoint handoffs before setup', () => {
    write('selected.sh', candidate.replace('ballin_select "$@"', 'ballin_select --branch main'));
    const r = run(['--branch', 'main']); assert.equal(r.status, 1); assert.include(r.stderr, 'handoff limit exceeded'); assert.notInclude(r.stdout, 'answer:');
    assert.equal(fs.readFileSync(path.join(root, 'requests'), 'utf8').split('/install.sh').length - 1, 4);
  });
  it('propagates the selected entrypoint failure without consuming stdin', () => {
    write('selected.sh', '#!/bin/bash\nIFS= read -r answer\nprintf "answer:%s\\n" "$answer"\nexit 23\n');
    const r = run(['--sha', sha]); assert.equal(r.status, 23); assert.include(r.stdout, 'answer:kept stdin');
  });
  for (const entry of process.platform === 'darwin' ? ['install.sh', 'quickstart.sh'] : ['install.sh']) {
    for (const protocol of [1, '1', true, null]) it(`validates contract JSON type through ${entry}: ${JSON.stringify(protocol)}`, () => {
      const source = candidate.replaceAll('ballin_entry=install.sh', `ballin_entry=${entry}`);
      write('entry.sh', source); write('selected.sh', source);
      write('curl', fs.readFileSync(path.join(root, 'curl'), 'utf8').replace("u.endsWith('/install.sh')", "(u.endsWith('/install.sh')||u.endsWith('/quickstart.sh'))"));
      write('contract.json', { protocol, minimumNode: '24.12.0' });
      const r = run(['--sha', sha]); assert.equal(r.status, protocol === 1 ? 0 : 1, r.stderr);
      if (protocol !== 1) { assert.notInclude(r.stdout, 'answer:'); assert.notInclude(fs.readFileSync(path.join(root, 'requests'), 'utf8'), `/${entry}`); }
    });
  }
  for (const status of [130, 143]) {
    it(`preserves metadata parser interruption ${status}`, () => {
      fs.writeFileSync(path.join(root, 'node'), `#!/bin/bash\nexit ${status}\n`, { mode: 0o700 });
      const r = run(['--sha', sha]); assert.equal(r.status, status); assert.notInclude(r.stdout, 'answer:');
    });
    it(`preserves early Git preflight interruption ${status}`, () => {
      fs.mkdirSync(path.join(root, '.ballin-scripts'));
      fs.writeFileSync(path.join(root, 'git'), `#!/bin/bash\nexit ${status}\n`, { mode: 0o700 });
      const r = run(['--sha', sha]); assert.equal(r.status, status); assert.notInclude(r.stdout, 'answer:');
    });
  }
});
