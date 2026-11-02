const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandbox, cleanupSandbox, sandboxEnvironment } = require('./helpers/onboarding.ts');

describe('guarded Quickstart platform JSON fixture', () => {
  it('matches native scalar types and extraction without accepting malformed data', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const file = path.join(sandbox.scratch, 'metadata.json');
      const env = sandboxEnvironment(sandbox);
      const run = (args: string[], executable = path.join(sandbox.root, 'plutil')) => spawnSync(executable, args, { env, encoding: 'utf8' });
      fs.writeFileSync(file, JSON.stringify({ object: { type: 'commit' }, protocol: 1, decimal: 1.5, draft: false, text: '1', absent: null }));
      for (const [key, type, raw] of [['object.type', 'string', 'commit'], ['protocol', 'integer', '1'], ['decimal', 'float', '1.500000'], ['draft', 'bool', 'false'], ['text', 'string', '1']]) {
        for (const [args, expected] of [[['-type', key, file], type], [['-extract', key, 'raw', '-o', '-', file], raw]] as [string[], string][]) {
          const result = run(args);
          assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
          if (process.platform === 'darwin') {
            const native = run(args, '/usr/bin/plutil');
            assert.equal(native.status, 0, native.stderr); assert.equal(result.stdout, native.stdout);
          }
        }
      }
      for (const key of ['missing', 'object.missing', 'absent', 'object', 'object.type.length']) assert.equal(run(['-type', key, file]).status, 1);
      fs.writeFileSync(file, '{'); assert.equal(run(['-type', 'protocol', file]).status, 1);
      assert.equal(run(['-convert', 'json', file]).status, 97);
      assert.equal(run(['-type', 'version', path.join(sandbox.root, '.ballin-onboarding-sandbox.json')]).status, 97);
      fs.unlinkSync(file); fs.symlinkSync(path.join(sandbox.root, '.ballin-onboarding-sandbox.json'), file);
      assert.equal(run(['-type', 'version', file]).status, 97);
    } finally { cleanupSandbox(sandbox.root); }
  });

  it('guards the copied entrypoint and parser against replacement', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      for (const file of [sandbox.quickstartEntry, path.join(sandbox.root, 'plutil')]) {
        const original = fs.readFileSync(file, 'utf8');
        fs.appendFileSync(file, '\n# changed\n');
        assert.throws(() => sandboxEnvironment(sandbox), /Sandbox safeguard was changed/u);
        fs.writeFileSync(file, original);
      }
    } finally { cleanupSandbox(sandbox.root); }
  });
});
