const fs = require('fs');
const path = require('path');

type ProcessRecord = { pid: number; parent: number; group: number; state: string };
// comm is parenthesized and may itself contain spaces or closing parentheses.
const parseProcessStat = (contents: string): ProcessRecord | undefined => {
  const match = contents.match(/^(\d+) \(.*\) ([A-Za-z]) (\d+) (\d+) /su);
  if (!match) return undefined;
  const [, pid, state, parent, group] = match;
  // A group outside the procfs PID namespace is reported as zero.
  const record = { pid: Number(pid), parent: Number(parent), group: Number(group), state };
  if (![record.pid, record.parent, record.group].every(Number.isSafeInteger) || record.pid < 1 || record.group < 0) return undefined;
  return record;
};
const dead = (record: ProcessRecord): boolean => ['Z', 'X', 'x'].includes(record.state);
// undefined means inspection cannot establish liveness; callers must fail closed.
const linuxProcessIsAlive = (pid: number, procRoot = '/proc'): boolean | undefined => {
  if (!Number.isSafeInteger(pid) || pid === 0) return undefined;
  try {
    if (pid > 0) {
      const record = parseProcessStat(fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8'));
      return record?.pid === pid ? !dead(record) : undefined;
    }
    let found = false;
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^[1-9]\d*$/u.test(entry)) continue;
      let contents: string;
      try { contents = fs.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8'); }
      catch (error) {
        // A process disappearing during enumeration is normal; other failures are ambiguous.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(path.join(procRoot, entry))) continue;
        return undefined;
      }
      const record = parseProcessStat(contents);
      if (!record || record.pid !== Number(entry)) return undefined;
      if (record.group !== -pid) continue;
      found = true;
      if (!dead(record)) return true;
    }
    return found ? false : undefined;
  } catch { return undefined; }
};
module.exports = { linuxProcessIsAlive, parseProcessStat };
export type { ProcessRecord };
