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
  it('parses PID, PPID, PGID and state despite spaces and parentheses in comm', () => {
    record(101, 'Z');
    assert.deepEqual(parseProcessStat(fs.readFileSync(path.join(root, '101/stat'), 'utf8')), { pid: 101, parent: 1, group: 100, state: 'Z' });
  });
  it('ignores only verified zombie/dead members, including orphaned whole groups', () => {
    record(100, 'Z'); record(101, 'Z'); record(102, 'X'); record(103, 'x');
    assert.isFalse(linuxProcessIsAlive(-100, root));
    assert.isFalse(linuxProcessIsAlive(101, root));
  });
  it('refuses groups with any live descendant and treats unfamiliar states as live', () => {
    for (const state of ['R', 'S', 'D', 'T', 't', 'I', 'Q']) {
      record(100, 'Z'); record(101, state, 100, 100); record(102, 'S', 200);
      assert.isTrue(linuxProcessIsAlive(-100, root));
      assert.isTrue(linuxProcessIsAlive(101, root));
    }
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
