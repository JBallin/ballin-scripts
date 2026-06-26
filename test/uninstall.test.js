const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relocateSystemPath } = require('../commands/ballin_uninstall.ts');

const uninstallPath = path.join(__dirname, '..', 'bin', 'ballin_uninstall');

describe('ballin_uninstall', () => {
  let testDir;
  let homeDir;
  let repoDir;
  let toolDir;
  let systemRoot;

  const commandPath = (name) => process.env.PATH
    .split(path.delimiter)
    .map((directory) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate));

  const writeExecutable = (name, contents) => {
    const executablePath = path.join(toolDir, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const createCommand = (name) => {
    const filePath = path.join(repoDir, 'bin', name);
    fs.writeFileSync(filePath, `${name}\n`);
    return filePath;
  };

  const runUninstall = ({ brewPrefix, commandPath: command = uninstallPath } = {}) => {
    if (brewPrefix) {
      writeExecutable('brew', `#!/usr/bin/env bash
if [ "$1" = '--prefix' ]; then
  printf '%s\\n' '${brewPrefix}'
  exit 0
fi
exit 2
`);
    }

    return spawnSync(command, [], {
      encoding: 'utf8',
      env: {
        HOME: homeDir,
        PATH: toolDir,
        BALLIN_UNINSTALL_TEST_SYSTEM_ROOT: systemRoot,
      },
    });
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-uninstall-'));
    homeDir = path.join(testDir, 'home');
    repoDir = path.join(homeDir, '.ballin-scripts');
    toolDir = path.join(testDir, 'tools');
    systemRoot = path.join(testDir, 'system');
    fs.mkdirSync(path.join(repoDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(systemRoot, 'usr', 'local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(systemRoot, 'opt', 'homebrew', 'bin'), { recursive: true });
    fs.mkdirSync(toolDir);
    const bashPath = commandPath('bash');
    assert.exists(bashPath, 'bash is required to run the uninstall test harness');
    fs.symlinkSync(bashPath, path.join(toolDir, 'bash'));
    fs.symlinkSync(process.execPath, path.join(toolDir, 'node'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves absolute legacy bin dirs outside the test system root', () => {
    assert.equal(relocateSystemPath('', '/usr/local/bin'), '/usr/local/bin');
    assert.equal(
      relocateSystemPath(systemRoot, '/usr/local/bin'),
      path.join(systemRoot, 'usr', 'local', 'bin'),
    );
  });

  it('removes only owned user-local links, then removes the repository', () => {
    const userBin = path.join(homeDir, '.local', 'bin');
    const ballin = createCommand('ballin');
    createCommand('gu');
    createCommand('up');
    fs.symlinkSync(ballin, path.join(userBin, 'ballin'));
    fs.writeFileSync(path.join(userBin, 'gu'), 'keep me\n');
    fs.symlinkSync(path.join(testDir, 'unrelated'), path.join(userBin, 'up'));

    const result = runUninstall();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "\nIt's been real...\nDeleted symlinked binaries\nPEACE! You still ballin tho...\n\n");
    assert.isFalse(fs.existsSync(path.join(userBin, 'ballin')));
    assert.isTrue(fs.statSync(path.join(userBin, 'gu')).isFile());
    assert.isTrue(fs.lstatSync(path.join(userBin, 'up')).isSymbolicLink());
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(testDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'ballin_uninstall');
    const userBin = path.join(homeDir, '.local', 'bin');
    const ballin = createCommand('ballin');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(uninstallPath, symlinkPath);
    fs.symlinkSync(ballin, path.join(userBin, 'ballin'));

    const result = runUninstall({ commandPath: symlinkPath });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "\nIt's been real...\nDeleted symlinked binaries\nPEACE! You still ballin tho...\n\n");
    assert.isFalse(fs.existsSync(path.join(userBin, 'ballin')));
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('continues removing the repository when an owned system link cannot be unlinked', function test() {
    if (process.platform === 'win32') {
      this.skip();
    }
    if (process.getuid?.() === 0) {
      this.skip();
    }

    const binDir = path.join(systemRoot, 'usr', 'local', 'bin');
    const ballin = createCommand('ballin');
    const linkPath = path.join(binDir, 'ballin');
    fs.symlinkSync(ballin, linkPath);
    fs.chmodSync(binDir, 0o555);

    try {
      const result = runUninstall();

      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stderr, 'ballin');
      assert.isTrue(fs.lstatSync(linkPath).isSymbolicLink());
      assert.isFalse(fs.existsSync(repoDir));
    } finally {
      fs.chmodSync(binDir, 0o755);
    }
  });

  [
    { name: 'Intel Homebrew', prefix: '/usr/local', relativeBin: ['usr', 'local', 'bin'] },
    { name: 'Apple Silicon Homebrew', prefix: '/opt/homebrew', relativeBin: ['opt', 'homebrew', 'bin'] },
  ].forEach(({ name, prefix, relativeBin }) => {
    it(`handles the ${name} location without checking it twice`, () => {
      const binDir = path.join(systemRoot, ...relativeBin);
      const ballin = createCommand('ballin');
      fs.symlinkSync(ballin, path.join(binDir, 'ballin'));

      const result = runUninstall({ brewPrefix: prefix });

      assert.equal(result.status, 0, result.stderr);
      assert.isFalse(fs.existsSync(path.join(binDir, 'ballin')));
    });
  });

  it('uses a custom Homebrew prefix', () => {
    const customPrefix = path.join(testDir, 'custom-homebrew');
    const customBin = path.join(customPrefix, 'bin');
    fs.mkdirSync(customBin, { recursive: true });
    const ballin = createCommand('ballin');
    fs.symlinkSync(ballin, path.join(customBin, 'ballin'));

    const result = runUninstall({ brewPrefix: customPrefix });

    assert.equal(result.status, 0, result.stderr);
    assert.isFalse(fs.existsSync(path.join(customBin, 'ballin')));
  });
});
