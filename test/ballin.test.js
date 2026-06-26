const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');

describe('ballin', () => {
  const assertHelpOutput = (result) => {
    assert.equal(result.status, 0);
    assert.include(result.stdout, 'A Collection of Ballin Scripts!');
    assert.include(result.stdout, 'ballin_update');
    assert.include(result.stdout, 'ballin_config');
    assert.include(result.stdout, 'ballin_uninstall');
    assert.include(result.stdout, 'gu');
    assert.include(result.stdout, 'up');
    assert.equal(result.stderr, '');
  };

  it('remains executable through its shebang', () => {
    assertHelpOutput(spawnSync(ballinPath, [], {
      encoding: 'utf8',
      env: process.env,
    }));
  });

  it('remains executable through the installed symlink model', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-bin-'));
    const symlinkPath = path.join(tempDir, 'ballin');

    try {
      fs.symlinkSync(ballinPath, symlinkPath);
      assertHelpOutput(spawnSync(symlinkPath, [], {
        encoding: 'utf8',
        env: process.env,
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
