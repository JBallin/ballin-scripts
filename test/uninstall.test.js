const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstallPath = path.join(__dirname, '..', 'bin', 'ballin_uninstall');

describe('ballin_uninstall', () => {
  let testDir;
  let homeDir;
  let repoDir;
  let toolDir;
  let systemRoot;
  let commandLogPath;

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

  const runUninstall = ({ brewPrefix } = {}) => {
    if (brewPrefix) {
      writeExecutable('brew', `#!/usr/bin/env bash
if [ "$1" = '--prefix' ]; then
  printf '%s\\n' '${brewPrefix}'
  exit 0
fi
exit 2
`);
    }

    return spawnSync(uninstallPath, [], {
      encoding: 'utf8',
      env: {
        HOME: homeDir,
        PATH: toolDir,
        BALLIN_UNINSTALL_TEST_SYSTEM_ROOT: systemRoot,
        FAKE_COMMAND_LOG: commandLogPath,
      },
    });
  };

  const commandLog = () => fs.readFileSync(commandLogPath, 'utf8');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-uninstall-'));
    homeDir = path.join(testDir, 'home');
    repoDir = path.join(homeDir, '.ballin-scripts');
    toolDir = path.join(testDir, 'tools');
    systemRoot = path.join(testDir, 'system');
    commandLogPath = path.join(testDir, 'commands.log');
    fs.mkdirSync(path.join(repoDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(systemRoot, 'usr', 'local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(systemRoot, 'opt', 'homebrew', 'bin'), { recursive: true });
    fs.mkdirSync(toolDir);
    fs.writeFileSync(commandLogPath, '');

    const bashPath = commandPath('bash');
    const readlinkPath = commandPath('readlink');
    const rmPath = commandPath('rm');
    assert.exists(bashPath, 'bash is required to run the uninstall test harness');
    assert.exists(readlinkPath, 'readlink is required to run the uninstall test harness');
    assert.exists(rmPath, 'rm is required to run the uninstall test harness');
    fs.symlinkSync(bashPath, path.join(toolDir, 'bash'));
    writeExecutable('readlink', `#!/usr/bin/env bash
printf 'readlink:%s\\n' "$1" >> "$FAKE_COMMAND_LOG"
exec '${readlinkPath}' "$@"
`);
    writeExecutable('rm', `#!/usr/bin/env bash
printf 'rm:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
exec '${rmPath}' "$@"
`);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
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

    const logLines = commandLog().trim().split('\n');
    assert.equal(logLines[0], `readlink:${path.join(userBin, 'ballin')}`);
    assert.equal(logLines[1], `rm:${path.join(userBin, 'ballin')}`);
    assert.equal(logLines.at(-1), `rm:-rf ${repoDir}`);
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
      assert.equal(
        commandLog().split('\n').filter((line) => line === `readlink:${path.join(binDir, 'ballin')}`).length,
        1,
      );
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
    assert.include(commandLog(), `rm:${path.join(customBin, 'ballin')}\n`);
  });
});
