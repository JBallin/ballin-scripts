const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const upPath = path.join(__dirname, '..', 'bin', 'up');

describe('up', () => {
  let tempDir;
  let binDir;
  let logPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-up-'));
    binDir = path.join(tempDir, 'bin');
    logPath = path.join(tempDir, 'nvm.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, 'ballin_config'),
      `#!/usr/bin/env bash
if [ "$2" = 'up.nvm' ]; then
  printf '%s\\n' "\${TEST_UP_NVM:-false}"
else
  printf '%s\\n' 'false'
fi
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const runUp = (env = {}) => spawnSync(upPath, [], {
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      NVM_TEST_LOG: logPath,
      TEST_UP_NVM: 'true',
      ...env,
    },
  });

  const installNvmStub = (nvmDir) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
}
`,
    );
  };

  it('loads nvm from NVM_DIR and updates Node.js LTS', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUp({ NVM_DIR: nvmDir });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'install --lts\n');
  });

  it('warns when nvm is enabled but cannot be loaded', () => {
    const result = runUp();

    assert.equal(result.status, 0);
    assert.include(result.stderr, 'unable to load nvm');
    assert.include(result.stderr, 'Set NVM_DIR');
    assert.include(result.stderr, 'ballin_config set up.nvm false');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('does not load nvm when the integration is disabled', () => {
    installNvmStub(path.join(tempDir, '.nvm'));

    const result = runUp({ TEST_UP_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Updating Node.js LTS');
    assert.notInclude(result.stderr, 'unable to load nvm');
    assert.isFalse(fs.existsSync(logPath));
  });
});
