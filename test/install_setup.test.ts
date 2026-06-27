const { assert } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  configure,
  symlinkBinaries,
} = require('../commands/install_setup.ts');

const installSetupPath = path.join(__dirname, '..', 'commands', 'install_setup.ts');
const repoRoot = path.join(__dirname, '..');

describe('install setup', () => {
  let testDir: string;
  let repoDir: string;
  let sourceBinDir: string;
  let binDir: string;
  const docsUrl = 'https://example.test/docs';

  const withoutStdout = (action: () => boolean): boolean => {
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      return action();
    } finally {
      process.stdout.write = originalWrite;
    }
  };

  const installConfigSources = () => {
    fs.mkdirSync(path.join(repoDir, 'config'), { recursive: true });
    ['.defaultConfig.json', 'index.ts', 'updateConfig.ts'].forEach((fileName) => {
      fs.copyFileSync(
        path.join(repoRoot, 'config', fileName),
        path.join(repoDir, 'config', fileName),
      );
    });
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-install-setup-'));
    repoDir = path.join(testDir, 'repo');
    sourceBinDir = path.join(repoDir, 'bin');
    binDir = path.join(testDir, 'home', '.local', 'bin');

    fs.mkdirSync(sourceBinDir, { recursive: true });
    fs.writeFileSync(path.join(sourceBinDir, 'ballin'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(sourceBinDir, 'gu'), '#!/usr/bin/env node\n');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the command directory and symlinks repository binaries', () => {
    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.isTrue(fs.lstatSync(path.join(binDir, 'gu')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
    assert.equal(fs.readlinkSync(path.join(binDir, 'gu')), path.join(sourceBinDir, 'gu'));
  });

  it('creates the default config through setup code', () => {
    installConfigSources();

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(repoDir, 'config', '.defaultConfig.json'), 'utf8')),
    );
  });

  it('runs config creation through the setup CLI', () => {
    installConfigSources();

    const result = spawnSync(process.execPath, [
      installSetupPath,
      'configure',
      repoDir,
      docsUrl,
    ], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Created 'ballin.config.json'");
    assert.isTrue(fs.existsSync(path.join(repoDir, 'ballin.config.json')));
  });

  it('updates an existing config through setup code', () => {
    installConfigSources();
    fs.writeFileSync(path.join(repoDir, 'ballin.config.json'), '{}\n');

    const result = withoutStdout(() => configure(repoDir, docsUrl));

    assert.isTrue(result);
    assert.include(
      fs.readFileSync(path.join(repoDir, 'ballin.config.json'), 'utf8'),
      '"up"',
    );
  });

  it('runs the symlink step through the setup CLI', () => {
    const result = spawnSync(process.execPath, [
      installSetupPath,
      'symlink-binaries',
      repoDir,
      binDir,
    ], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, `symlinked binaries into ${binDir}`);
    assert.isTrue(fs.lstatSync(path.join(binDir, 'ballin')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('replaces existing command symlinks', () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(testDir, 'old-ballin'), path.join(binDir, 'ballin'));

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isTrue(result);
    assert.equal(fs.readlinkSync(path.join(binDir, 'ballin')), path.join(sourceBinDir, 'ballin'));
  });

  it('fails when a command target cannot be replaced', () => {
    fs.mkdirSync(path.join(binDir, 'ballin'), { recursive: true });

    const result = withoutStdout(() => symlinkBinaries(repoDir, binDir));

    assert.isFalse(result);
    assert.isTrue(fs.statSync(path.join(binDir, 'ballin')).isDirectory());
  });
});
