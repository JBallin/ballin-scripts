const fs = require('fs') as typeof import('fs');
const os = require('os');
const path = require('path');
const { fixtureDestination } = require('./helpers/repository.ts');
const { repositoryCacheDirectory } = require('../commands/backup_repository.ts');
const { lastSuccessFileName, readLastBackupSuccess, recordLastBackupSuccess, lastBackupSuccessLine, previousBackupSuccessLine } = require('../commands/backup_status.ts');
const { withEnvironment } = require('./helpers/environment.ts');

describe('destination-scoped local last-success status', () => {
  let root: string; let directory: string; let file: string;
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-status-test-'));
    directory = repositoryCacheDirectory(root, fixtureDestination);
    file = path.join(directory, lastSuccessFileName);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = (text = `${new Date(now).toISOString()}\n`) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  it('creates and replaces only a private canonical time under umask 000', () => {
    const previous = process.umask(0);
    try {
      assert.isTrue(recordLastBackupSuccess(root, fixtureDestination, now));
      assert.isTrue(recordLastBackupSuccess(root, fixtureDestination, now + 1));
      assert.equal(readLastBackupSuccess(root, fixtureDestination, now + 1), new Date(now + 1).toISOString());
      assert.equal(fs.readFileSync(file, 'utf8'), `${new Date(now + 1).toISOString()}\n`);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(directory), [lastSuccessFileName]);
    } finally { process.umask(previous); }
  });
  it('uses stable identity and branch without current revision or mutable name', () => {
    seed();
    assert.equal(readLastBackupSuccess(root, { ...fixtureDestination, name: 'renamed' }, now), new Date(now).toISOString());
    for (const change of [{ ownerId: 'other' }, { id: 'other' }, { branch: 'other' }]) {
      assert.isNull(readLastBackupSuccess(root, { ...fixtureDestination, ...change }, now));
    }
  });
  it('creates private local state even when a successful no-op had no cache entries', () => {
    fs.rmdirSync(root);
    assert.isTrue(recordLastBackupSuccess(root, fixtureDestination, now));
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(readLastBackupSuccess(root, fixtureDestination, now), new Date(now).toISOString());
  });
  it('reports unavailable without creating or repairing state', () => {
    assert.include(lastBackupSuccessLine(root, fixtureDestination), 'unavailable');
    assert.isNull(previousBackupSuccessLine(root, fixtureDestination));
    for (const text of ['bad', '2026-10-02T12:00:00Z\n', `${new Date(now + 1).toISOString()}\n`, 'x'.repeat(1000), '1969-12-31T23:59:59.000Z\n']) {
      seed(text);
      assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
    seed(); fs.chmodSync(file, 0o644);
    assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
    assert.isNull(previousBackupSuccessLine(root, fixtureDestination));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    fs.chmodSync(file, 0o600); fs.chmodSync(directory, 0o755);
    assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now + 1));
    fs.chmodSync(directory, 0o700); fs.chmodSync(root, 0o755);
    assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
    assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now + 1));
  });
  it('refuses symlink and directory status without changing targets', () => {
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(root, 'target'); fs.writeFileSync(target, 'target bytes');
    fs.symlinkSync(target, file);
    assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
    assert.isNull(previousBackupSuccessLine(root, fixtureDestination));
    assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now));
    assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes');
    assert.isTrue(fs.lstatSync(file).isSymbolicLink());
    fs.unlinkSync(file); fs.mkdirSync(file, { mode: 0o700 });
    assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
    assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now));
  });
  it('formats the full local date and distinguishes repeated daylight-saving hours', () => {
    withEnvironment({ TZ: 'America/Los_Angeles' }, () => {
      seed('2025-11-02T08:30:00.000Z\n');
      assert.equal(previousBackupSuccessLine(root, fixtureDestination), 'Last successful backup: Nov 2, 2025, 1:30:00 AM GMT-07:00');
      seed('2025-11-02T09:30:00.000Z\n');
      assert.equal(previousBackupSuccessLine(root, fixtureDestination), 'Last successful backup: Nov 2, 2025, 1:30:00 AM GMT-08:00');
    });
    withEnvironment({ TZ: 'Asia/Kolkata' }, () => {
      seed('2020-01-01T00:00:00.000Z\n');
      assert.equal(previousBackupSuccessLine(root, fixtureDestination), 'Last successful backup: Jan 1, 2020, 5:30:00 AM GMT+05:30');
    });
  });
  it('omits malformed and future records without rewriting them', () => {
    for (const text of ['invalid\n', '2020-01-01T00:00:00Z\n', '2099-01-01T00:00:00.000Z\n']) {
      seed(text);
      assert.isNull(previousBackupSuccessLine(root, fixtureDestination));
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
  });
  it('preserves prior bytes on write/rename failure and retries normally', () => {
    seed();
    for (const method of ['writeFileSync', 'renameSync'] as const) {
      const original = fs[method];
      Reflect.set(fs, method, () => { throw new Error('fixture failure'); });
      try { assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now + 1)); } finally { Reflect.set(fs, method, original); }
      assert.equal(fs.readFileSync(file, 'utf8'), `${new Date(now).toISOString()}\n`);
      assert.deepEqual(fs.readdirSync(directory), [lastSuccessFileName]);
    }
    assert.isTrue(recordLastBackupSuccess(root, fixtureDestination, now + 1));
  });
  it('retains successful replacement if best-effort staging cleanup fails', () => {
    seed(); const original = fs.rmSync;
    fs.rmSync = () => { throw new Error('fixture cleanup'); };
    try { assert.isTrue(recordLastBackupSuccess(root, fixtureDestination, now)); } finally { fs.rmSync = original; }
    assert.equal(readLastBackupSuccess(root, fixtureDestination, now), new Date(now).toISOString());
  });
  it('treats directory creation and ownership failures as advisory', () => {
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = () => { throw new Error('fixture mkdir'); };
    try { assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now)); } finally { fs.mkdirSync = mkdir; }
    seed(); const lstat = fs.lstatSync;
    for (const entry of [root, directory, file]) {
      Reflect.set(fs, 'lstatSync', (name: string, ...args: unknown[]) => {
        const stat = Reflect.apply(lstat, fs, [name, ...args]);
        if (name === entry) return Object.assign(Object.create(stat), { uid: process.getuid!() + 1 });
        return stat;
      });
      try {
        assert.isNull(readLastBackupSuccess(root, fixtureDestination, now));
        assert.isFalse(recordLastBackupSuccess(root, fixtureDestination, now + 1));
      } finally { Reflect.set(fs, 'lstatSync', lstat); }
      assert.equal(fs.readFileSync(file, 'utf8'), `${new Date(now).toISOString()}\n`);
    }
  });
  it('rejects nonprivate opened-file metadata and tolerates read-close failure', () => {
    seed(); const fstat = fs.fstatSync;
    for (const override of [{ uid: process.getuid!() + 1 }, { mode: 0o644 }, { isFile: () => false }, { size: 24 }]) {
      Reflect.set(fs, 'fstatSync', (descriptor: number) => Object.assign(Object.create(fstat(descriptor)), override));
      try { assert.isNull(readLastBackupSuccess(root, fixtureDestination, now)); } finally { fs.fstatSync = fstat; }
    }
    const close = fs.closeSync;
    fs.closeSync = (descriptor) => { close(descriptor); throw new Error('fixture close'); };
    try { assert.equal(readLastBackupSuccess(root, fixtureDestination, now), new Date(now).toISOString()); } finally { fs.closeSync = close; }
  });
});
