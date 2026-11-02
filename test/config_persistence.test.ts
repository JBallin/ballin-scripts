const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createConfigStore } = require('../config/store.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('atomic config persistence', () => {
  let root: string;
  let configPath: string;
  const original = '{"update":{"cleanup":"true"},"backup":{"repository":"fixture"}}\n';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-persistence-'));
    configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, original, { mode: 0o640 });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  for (const operation of ['set', 'reset', 'migration']) {
    for (const fault of ['partial-write', 'rename']) {
      it(`preserves config and removes staging after ${operation} ${fault} failure`, () => {
        const modulePath = operation === 'migration'
          ? path.resolve(__dirname, '../config/updateConfig.ts') : path.resolve(__dirname, '../bin/ballin');
        const args = operation === 'set' ? ['config', 'set', 'update.cleanup', 'false'] : ['config', 'reset'];
        const script = `
          const fs = require('fs');
          const target = fs.realpathSync(process.env.BALLIN_TEST_CONFIG_PATH);
          const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync;
          let stagedFd, injected = false;
          fs.openSync = (file, ...args) => {
            const fd = open(file, ...args);
            if (typeof file === 'string' && file.startsWith(target + '.')) stagedFd = fd;
            return fd;
          };
          fs.writeFileSync = (file, data, ...args) => {
            if (${JSON.stringify(fault)} === 'partial-write' && file === stagedFd) {
              fs.writeSync(file, String(data).slice(0, 8));
              injected = true;
              throw Object.assign(new Error('Synthetic partial write'), { code: 'ENOSPC' });
            }
            return write(file, data, ...args);
          };
          fs.renameSync = (source, destination) => {
            if (${JSON.stringify(fault)} === 'rename' && destination === target) {
              injected = true;
              throw Object.assign(new Error('Synthetic rename failure'), { code: 'EACCES' });
            }
            return rename(source, destination);
          };
          process.on('exit', () => { if (!injected) process.exitCode = 99; });
          process.argv = [process.execPath, ${JSON.stringify(modulePath)}, ...${JSON.stringify(args)}];
          require(${JSON.stringify(modulePath)});
        `;
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8', env: testChildEnvironment({ BALLIN_TEST_CONFIG_PATH: configPath }), timeout: 5000,
        });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.equal(fs.readFileSync(configPath, 'utf8'), original);
        assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
        assert.deepEqual(fs.readdirSync(root), ['config.json']);
        if (operation !== 'migration') assert.equal(result.stderr,
          'ballin config: Unable to save config. Check that the config file and its parent directory are writable.\n');
      });
    }
  }

  it('preserves existing permissions even under a restrictive umask', () => {
    const before = process.umask(0o077);
    try { createConfigStore({ configPath }).setConfig('update.cleanup', 'false'); }
    finally { process.umask(before); }
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).update.cleanup, 'false');
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  });

  it('updates an existing symlink target while retaining the link and target permissions', () => {
    const link = path.join(root, 'link.json');
    fs.symlinkSync('config.json', link);
    createConfigStore({ configPath: link }).setConfig('update.cleanup', 'false');
    assert.isTrue(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).update.cleanup, 'false');
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'link.json']);
  });

  it('recreates missing config privately on reset', () => {
    fs.unlinkSync(configPath);
    createConfigStore({ configPath }).resetConfig();
    assert.isObject(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  });

  it('refuses to replace a dangling symlink on reset', () => {
    const link = path.join(root, 'link.json');
    fs.symlinkSync('missing.json', link);
    assert.throws(() => createConfigStore({ configPath: link }).resetConfig(), 'Unable to save config.');
    assert.isTrue(fs.lstatSync(link).isSymbolicLink());
    assert.isFalse(fs.existsSync(path.join(root, 'missing.json')));
    assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'link.json']);
  });

  it('refuses to silently detach hard-linked settings', () => {
    const link = path.join(root, 'link.json');
    fs.linkSync(configPath, link);
    assert.throws(() => createConfigStore({ configPath }).setConfig('update.cleanup', 'false'), 'Unable to save config.');
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(link, 'utf8'), original);
    assert.equal(fs.statSync(configPath).ino, fs.statSync(link).ino);
    assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'link.json']);
  });
});
