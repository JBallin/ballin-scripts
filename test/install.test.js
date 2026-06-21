const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installPath = path.join(__dirname, '..', 'install.sh');

describe('install', () => {
  let homeDir;
  let binDir;
  let repoDir;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-'));
    binDir = path.join(homeDir, '.local', 'bin');
    repoDir = path.join(homeDir, '.ballin-scripts');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(repoDir);
    fs.symlinkSync('/bin/bash', path.join(binDir, 'bash'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('stops with guidance when Node.js is unavailable', () => {
    const result = spawnSync(installPath, [], {
      encoding: 'utf8',
      env: {
        HOME: homeDir,
        PATH: binDir,
      },
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Node.js is required');
    assert.include(result.stdout, 'Node.js LTS with nvm');
    assert.include(result.stdout, 'docs/optional-capabilities.md');
    assert.include(result.stdout, 'brew install node');
    assert.include(result.stdout, 'run this installer again');
    assert.isFalse(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });
});
