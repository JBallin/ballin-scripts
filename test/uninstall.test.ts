const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relocateSystemPath } = require('../commands/uninstall.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type RunUninstallOptions = {
  brewPrefix?: string;
  commandPath?: string;
  preloadPath?: string;
};

describe('ballin uninstall', () => {
  let testDir: string;
  let homeDir: string;
  let repoDir: string;
  let toolDir: string;
  let systemRoot: string;

  const commandPath = (name: string) => (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate));

  const writeExecutable = (name: string, contents: string) => {
    const executablePath = path.join(toolDir, name);
    fs.writeFileSync(executablePath, contents, { mode: 0o755 });
    return executablePath;
  };

  const createCommand = (name: string) => {
    const filePath = path.join(repoDir, 'bin', name);
    fs.writeFileSync(filePath, `${name}\n`);
    return filePath;
  };

  const runUninstall = ({
    brewPrefix,
    commandPath: command = ballinPath,
    preloadPath,
  }: RunUninstallOptions = {}) => {
    if (brewPrefix) {
      writeExecutable('brew', `#!/usr/bin/env bash
if [ "$1" = '--prefix' ]; then
  printf '%s\\n' '${brewPrefix}'
  exit 0
fi
exit 2
`);
    }

    return spawnSync(
      preloadPath ? process.execPath : command,
      preloadPath ? ['--require', preloadPath, command, 'uninstall'] : ['uninstall'],
      {
        encoding: 'utf8',
        env: {
          HOME: homeDir,
          PATH: toolDir,
          BALLIN_NO_ANALYTICS: '1',
          BALLIN_UNINSTALL_TEST_SYSTEM_ROOT: systemRoot,
        },
      },
    );
  };

  const writeFsFailurePreload = (
    operation: 'lstatSync' | 'unlinkSync',
    candidatePath: string,
    errorCode: string,
  ) => {
    const preloadPath = path.join(testDir, `${operation}-failure.cjs`);
    fs.writeFileSync(preloadPath, `const fs = require('fs');
const operation = ${JSON.stringify(operation)};
const candidatePath = ${JSON.stringify(candidatePath)};
const originalOperation = fs[operation];
fs[operation] = (currentPath, ...args) => {
  if (currentPath === candidatePath) {
    if (operation === 'unlinkSync') {
      originalOperation(currentPath, ...args);
    }
    const error = new Error(operation + ' failed for ' + currentPath);
    error.code = ${JSON.stringify(errorCode)};
    throw error;
  }
  return originalOperation(currentPath, ...args);
};
`);
    return preloadPath;
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
    fs.symlinkSync(ballin, path.join(userBin, 'ballin'));
    fs.writeFileSync(path.join(userBin, 'unrelated-file'), 'keep me\n');
    fs.symlinkSync(path.join(testDir, 'unrelated'), path.join(userBin, 'unrelated-link'));
    const remoteGistFixture = path.join(testDir, 'remote-gist');
    fs.writeFileSync(remoteGistFixture, 'remote destination remains\n');

    const result = runUninstall();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "\nIt's been real...\nDeleted symlinked binaries\nPEACE! You still ballin tho...\n\n");
    assert.isFalse(fs.existsSync(path.join(userBin, 'ballin')));
    assert.isTrue(fs.statSync(path.join(userBin, 'unrelated-file')).isFile());
    assert.isTrue(fs.lstatSync(path.join(userBin, 'unrelated-link')).isSymbolicLink());
    assert.isFalse(fs.existsSync(repoDir));
    assert.equal(fs.readFileSync(remoteGistFixture, 'utf8'), 'remote destination remains\n');
  });

  it('preserves a regular file that has the same name as an installed command', () => {
    const userBin = path.join(homeDir, '.local', 'bin');
    createCommand('ballin');
    const regularFile = path.join(userBin, 'ballin');
    fs.writeFileSync(regularFile, 'user-owned command\n');

    const result = runUninstall();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(regularFile, 'utf8'), 'user-owned command\n');
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(testDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'ballin');
    const userBin = path.join(homeDir, '.local', 'bin');
    const ballin = createCommand('ballin');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(ballinPath, symlinkPath);
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

      assert.equal(result.status, 1, result.stderr);
      assert.equal(
        result.stdout,
        "\nIt's been real...\nRemoved the local checkout, but symlink cleanup is incomplete.\n\n",
      );
      assert.include(result.stderr, 'ballin');
      assert.include(result.stderr, 'Uninstall incomplete: these Ballin-owned links remain:');
      assert.include(result.stderr, `  ${linkPath}\n`);
      assert.include(
        result.stderr,
        'Remove the listed links with rm. If removal fails because of permissions, '
          + 'rerun rm with elevated permissions (for example, sudo rm).',
      );
      assert.isTrue(fs.lstatSync(linkPath).isSymbolicLink());
      assert.isFalse(fs.existsSync(repoDir));
    } finally {
      fs.chmodSync(binDir, 0o755);
    }
  });

  it('reports an unverified candidate path when link inspection fails', () => {
    const binDir = path.join(systemRoot, 'usr', 'local', 'bin');
    const ballin = createCommand('ballin');
    const linkPath = path.join(binDir, 'ballin');
    fs.symlinkSync(ballin, linkPath);
    const preloadPath = writeFsFailurePreload('lstatSync', linkPath, 'EACCES');

    const result = runUninstall({ preloadPath });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      result.stdout,
      "\nIt's been real...\nRemoved the local checkout, but symlink cleanup is incomplete.\n\n",
    );
    assert.include(result.stderr, `lstatSync failed for ${linkPath}`);
    assert.include(result.stderr, 'These candidate Ballin link paths could not be inspected:');
    assert.include(result.stderr, `  ${linkPath}\n`);
    assert.include(
      result.stderr,
      'Resolve the reported filesystem errors, then inspect these paths before removing anything.',
    );
    assert.notInclude(result.stderr, 'Remove the listed links with rm.');
    assert.isTrue(fs.lstatSync(linkPath).isSymbolicLink());
    assert.isFalse(fs.existsSync(repoDir));
  });

  it('succeeds when an owned link disappears before unlink completes', () => {
    const binDir = path.join(systemRoot, 'usr', 'local', 'bin');
    const ballin = createCommand('ballin');
    const linkPath = path.join(binDir, 'ballin');
    fs.symlinkSync(ballin, linkPath);
    const preloadPath = writeFsFailurePreload('unlinkSync', linkPath, 'ENOENT');

    const result = runUninstall({ preloadPath });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, "\nIt's been real...\nDeleted symlinked binaries\nPEACE! You still ballin tho...\n\n");
    assert.isFalse(fs.existsSync(linkPath));
    assert.isFalse(fs.existsSync(repoDir));
  });

  ([
    { name: 'Intel Homebrew', prefix: '/usr/local', relativeBin: ['usr', 'local', 'bin'] },
    { name: 'Apple Silicon Homebrew', prefix: '/opt/homebrew', relativeBin: ['opt', 'homebrew', 'bin'] },
  ] as { name: string; prefix: string; relativeBin: string[] }[]).forEach(({ name, prefix, relativeBin }) => {
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
