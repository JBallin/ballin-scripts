const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandbox, cleanupSandbox, sandboxEnvironment } = require('./helpers/onboarding.ts');

describe('guarded Quickstart platform JSON fixture', () => {
  let sandbox: import('./helpers/onboarding.ts').Sandbox;
  let file: string;
  beforeEach(() => {
    sandbox = createSandbox({ quickstart: true });
    file = path.join(sandbox.scratch, 'metadata.json');
    fs.writeFileSync(file, JSON.stringify({ object: { type: 'commit' }, protocol: 1, decimal: 1.5, draft: false, text: '1', absent: null }));
  });
  afterEach(() => cleanupSandbox(sandbox.root));
  const run = (args: string[], executable = path.join(sandbox.root, 'plutil')) => spawnSync(executable, args, {
    env: sandboxEnvironment(sandbox), encoding: 'utf8',
  });

  // Each independent CLI case gets the normal timeout instead of accumulating
  // all process startup and coverage overhead under one two-second budget.
  for (const [key, type, raw] of [['object.type', 'string', 'commit'], ['protocol', 'integer', '1'], ['decimal', 'float', '1.500000'], ['draft', 'bool', 'false'], ['text', 'string', '1']]) {
    it(`matches native scalar type and extraction for ${key}`, () => {
      for (const [args, expected] of [[['-type', key, file], type], [['-extract', key, 'raw', '-o', '-', file], raw]] as [string[], string][]) {
        const result = run(args);
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
        if (process.platform === 'darwin') {
          const native = run(args, '/usr/bin/plutil');
          assert.equal(native.status, 0, native.stderr); assert.equal(result.stdout, native.stdout);
        }
      }
    });
  }
  for (const key of ['missing', 'object.missing', 'absent', 'object', 'object.type.length']) {
    it(`rejects missing or nonscalar metadata at ${key}`, () => {
      assert.equal(run(['-type', key, file]).status, 1);
    });
  }
  it('rejects malformed JSON', () => {
    fs.writeFileSync(file, '{'); assert.equal(run(['-type', 'protocol', file]).status, 1);
  });
  it('rejects unsupported operations', () => {
    assert.equal(run(['-convert', 'json', file]).status, 97);
  });
  it('rejects files outside scratch', () => {
    assert.equal(run(['-type', 'version', path.join(sandbox.root, '.ballin-onboarding-sandbox.json')]).status, 97);
  });
  it('rejects symlinked input files', () => {
    fs.unlinkSync(file); fs.symlinkSync(path.join(sandbox.root, '.ballin-onboarding-sandbox.json'), file);
    assert.equal(run(['-type', 'version', file]).status, 97);
  });

  it('guards the copied entrypoint and parser against replacement', () => {
    for (const file of [sandbox.quickstartEntry, path.join(sandbox.root, 'plutil')]) {
      const original = fs.readFileSync(file, 'utf8');
      fs.appendFileSync(file, '\n# changed\n');
      assert.throws(() => sandboxEnvironment(sandbox), /Sandbox safeguard was changed/u);
      fs.writeFileSync(file, original);
    }
  });
});
