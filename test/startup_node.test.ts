const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const launcher = path.resolve(__dirname, '../bin/ballin');
const requirement = require('../package.json').engines.node;

describe('public launcher Node.js requirement', () => {
  const run = (version: string, symlink: boolean, metadata: unknown = { engines: { node: requirement } }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-startup-node-'));
    try {
      fs.mkdirSync(path.join(root, 'bin'));
      fs.mkdirSync(path.join(root, 'commands'));
      fs.copyFileSync(launcher, path.join(root, 'bin/ballin'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata));
      // If the guard loads TypeScript too early, this produces a different error.
      fs.writeFileSync(path.join(root, 'commands/ballin.ts'), version.startsWith('20.') || version.startsWith('22.') || version === '24.11.99'
        ? 'throw new Error("TypeScript loaded before runtime rejection");\n'
        : 'module.exports.runBallinCli = () => process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');
      const preload = path.join(root, 'runtime.cjs');
      fs.writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
      const command = symlink ? path.join(root, 'ballin') : path.join(root, 'bin/ballin');
      if (symlink) fs.symlinkSync(path.join(root, 'bin/ballin'), command);
      return spawnSync(process.execPath, ['--require', preload, command, 'help'], {
        encoding: 'utf8', timeout: 10000,
        env: testChildEnvironment({ HOME: root, TMPDIR: root }),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('uses the package minimum in the supported minimum-only format', () => {
    assert.match(requirement, /^>=\d+\.\d+(?:\.\d+)?$/u);
  });

  for (const symlink of [false, true]) {
    for (const version of ['20.19.0', '22.14.0', '24.11.99']) {
      it(`rejects ${version} before loading TypeScript (${symlink ? 'symlink' : 'direct'})`, () => {
        const result = run(version, symlink);
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Ballin requires Node.js 24.12 or newer; found ${version}. Upgrade or activate Node.js, then retry.\n`);
      });
    }
    for (const version of ['24.12.0', '24.12.1', '25.0.0', '26.13.1']) {
      it(`preserves CLI arguments on ${version} (${symlink ? 'symlink' : 'direct'})`, () => {
        const result = run(version, symlink);
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, '["help"]\n');
      });
    }
  }

  it('reads a changed patch-level minimum from package metadata', () => {
    const result = run('26.13.1', true, { engines: { node: '>=26.13.2' } });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Ballin requires Node.js 26.13.2 or newer; found 26.13.1. Upgrade or activate Node.js, then retry.\n');
  });

  for (const metadata of [
    {}, { engines: {} }, { engines: null },
    ...[null, 24, '', '^24.12', '>=24.12 <27', '>=24.12 || >=26', '>=24.x', '>=24.12.0.1', '>=24.nope', '>=24.12.0-beta.1']
      .map((node) => ({ engines: { node } })),
  ]) {
    for (const version of ['20.19.0', '26.13.1']) {
      it(`rejects invalid requirement metadata ${JSON.stringify(metadata)} on ${version} before loading TypeScript`, () => {
        const result = run(version, false, metadata);
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'Ballin could not read engines.node in package.json. Expected a minimum Node.js version such as ">=24.12".\n');
      });
    }
  }
});
