const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxProcessIsAlive, parseProcessStat } = require('./helpers/process_liveness.ts');

describe('sandbox Linux process liveness', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-process-stat-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const record = (pid: number, state: string, group = 100, parent = 1): void => {
    const directory = path.join(root, String(pid));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'stat'), `${pid} (fixture ) process) ${state} ${parent} ${group} 0 0 0\n`);
  };
  const withStatRead = (pid: number, read: () => string, inspect: () => void): void => {
    const original = fs.readFileSync;
    const stat = path.join(root, String(pid), 'stat');
    fs.readFileSync = (file: string, ...args: unknown[]) => file === stat ? read() : original(file, ...args);
    try { inspect(); } finally { fs.readFileSync = original; }
  };
  it('parses PID, PPID, PGID and state despite spaces and parentheses in comm', () => {
    record(101, 'Z');
    assert.deepEqual(parseProcessStat(fs.readFileSync(path.join(root, '101/stat'), 'utf8')), { pid: 101, parent: 1, group: 100, state: 'Z' });
  });
  it('ignores only verified zombie/dead members, including orphaned whole groups', () => {
    record(100, 'Z'); record(101, 'Z'); record(102, 'X'); record(103, 'x');
    assert.isFalse(linuxProcessIsAlive(-100, root));
    assert.isFalse(linuxProcessIsAlive(101, root));
  });
  it('accepts namespace-visible zero PGIDs without matching a positive sandbox group', () => {
    record(1, 'S', 0, 0); record(100, 'Z'); record(101, 'Z');
    assert.deepEqual(parseProcessStat(fs.readFileSync(path.join(root, '1/stat'), 'utf8')), { pid: 1, parent: 0, group: 0, state: 'S' });
    assert.isTrue(linuxProcessIsAlive(1, root));
    assert.isFalse(linuxProcessIsAlive(-100, root));
    record(101, 'S');
    assert.isTrue(linuxProcessIsAlive(-100, root));
    assert.isUndefined(linuxProcessIsAlive(-200, root));
  });
  it('refuses groups with any live descendant and treats unfamiliar states as live', () => {
    for (const state of ['R', 'S', 'D', 'T', 't', 'I', 'Q']) {
      record(100, 'Z'); record(101, state, 100, 100); record(102, 'S', 200);
      assert.isTrue(linuxProcessIsAlive(-100, root));
      assert.isTrue(linuxProcessIsAlive(101, root));
    }
  });
  it('keeps malformed numeric records and invalid target groups ambiguous', () => {
    for (const contents of [
      '0 (invalid PID) S 0 0 0\n',
      '100 (invalid group) S 1 -1 0\n',
      '100 (fractional group) S 1 0.5 0\n',
      '100 (unsafe group) S 1 9007199254740992 0\n',
    ]) assert.isUndefined(parseProcessStat(contents));
    for (const target of [0, 1.5, -1.5, Number.MAX_SAFE_INTEGER + 1]) assert.isUndefined(linuxProcessIsAlive(target, root));
  });
  it('skips ENOENT and ESRCH reads only after verifying the enumerated PID disappeared', () => {
    for (const code of ['ENOENT', 'ESRCH']) {
      record(100, 'Z'); record(200, 'S', 200);
      withStatRead(200, () => {
        fs.rmSync(path.join(root, '200'), { recursive: true });
        throw Object.assign(new Error('fixture process exited'), { code });
      }, () => assert.isFalse(linuxProcessIsAlive(-100, root)));
      record(200, 'S', 200);
      withStatRead(200, () => {
        throw Object.assign(new Error('fixture record unavailable'), { code });
      }, () => assert.isUndefined(linuxProcessIsAlive(-100, root)));
      fs.rmSync(path.join(root, '200'), { recursive: true });
      record(200, 'S', 100);
      withStatRead(200, () => {
        throw Object.assign(new Error('fixture target record unavailable'), { code });
      }, () => assert.isUndefined(linuxProcessIsAlive(-100, root)));
    }
  });
  it('skips malformed dying records only after their PID directory disappears', () => {
    for (const state of ['X', 'S']) {
      record(100, 'Z'); record(200, state, 200);
      const invalid = `200 (dying fixture) ${state} 0 -1 0\n`;
      assert.isUndefined(parseProcessStat(invalid));
      withStatRead(200, () => invalid, () => assert.isUndefined(linuxProcessIsAlive(-100, root)));
      withStatRead(200, () => {
        fs.rmSync(path.join(root, '200'), { recursive: true });
        return invalid;
      }, () => assert.isFalse(linuxProcessIsAlive(-100, root)));
    }
    record(101, 'S'); record(50, 'X', 200);
    withStatRead(50, () => {
      fs.rmSync(path.join(root, '50'), { recursive: true });
      return '50 (dying fixture) X 0 -1 0\n';
    }, () => assert.isTrue(linuxProcessIsAlive(-100, root)));
  });
  it('keeps permission errors ambiguous while checking whether a PID disappeared', () => {
    record(100, 'Z'); record(200, 'S', 200);
    const original = fs.lstatSync;
    fs.lstatSync = (file: string, ...args: unknown[]) => {
      if (file === path.join(root, '200')) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
      return original(file, ...args);
    };
    try {
      withStatRead(200, () => {
        throw Object.assign(new Error('fixture record unavailable'), { code: 'ESRCH' });
      }, () => assert.isUndefined(linuxProcessIsAlive(-100, root)));
    } finally { fs.lstatSync = original; }
  });
  it('fails closed for unreadable, malformed, missing or mismatched inspection evidence', () => {
    record(100, 'Z');
    assert.isUndefined(linuxProcessIsAlive(-200, root));
    assert.isUndefined(linuxProcessIsAlive(999, root));
    fs.writeFileSync(path.join(root, '100/stat'), 'not kernel process evidence');
    assert.isUndefined(linuxProcessIsAlive(-100, root));
    record(100, 'Z');
    fs.writeFileSync(path.join(root, '100/stat'), '101 (wrong PID) Z 1 100 0\n');
    assert.isUndefined(linuxProcessIsAlive(-100, root));
    fs.rmSync(path.join(root, '100/stat'));
    assert.isUndefined(linuxProcessIsAlive(-100, root));
    fs.mkdirSync(path.join(root, '100/stat'));
    assert.isUndefined(linuxProcessIsAlive(-100, root));
    assert.isUndefined(linuxProcessIsAlive(-100, path.join(root, 'missing')));
  });
});
