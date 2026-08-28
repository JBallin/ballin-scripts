const path = require('path');
const {
  runCommand,
} = require('../commands/commandHelpers.ts');

describe('command helpers', () => {
  it('enforces string encoding and direct execution at runtime', () => {
    const result = runCommand(process.execPath, [
      '-e',
      'process.stdout.write("direct execution")',
    ], {
      encoding: 'buffer',
      shell: path.join(__dirname, 'missing-shell'),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, 'direct execution');
  });
});
