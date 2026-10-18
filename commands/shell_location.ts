// Resolve a bounded hint from the original invoking shell. Never execute a startup file.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const preserveInterruption = (result: { signal: string | null; status: number | null; error?: unknown }): void => {
  if (!result.error && (result.signal === 'SIGINT' || result.signal === 'SIGTERM' || result.status === 130 || result.status === 143)) {
    // This self-contained helper also runs from Quickstart's private download.
    const status = result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : result.status!;
    process.exit(status);
  }
};

type ShellEvidence = { parent: (pid: number) => number | null; executable: (pid: number) => string | null };
const processEvidence: ShellEvidence = {
  parent: (pid) => {
    const result = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    preserveInterruption(result);
    return result.status === 0 && /^\s*\d+\s*$/u.test(result.stdout) ? Number(result.stdout.trim()) : null;
  },
  executable: (pid) => {
    if (process.platform !== 'darwin') return null;
    // proc_pidpath supplies executable identity; ps comm/argv and mapped images do not.
    const program = 'ObjC.import("Foundation"); ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "uint32_t"]]); function run(args) { var data = $.NSMutableData.dataWithLength(4096); var count = $.proc_pidpath(Number(args[0]), data.mutableBytes, 4096); if (count <= 0 || count >= 4096) return ""; return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)).split("\\0")[0]; }';
    const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', program, String(pid)], { encoding: 'utf8', timeout: 5000 });
    preserveInterruption(result);
    return result.status === 0 ? result.stdout.replace(/\n$/u, '') : null;
  },
};

const zshStartupDirectory = (
  env: NodeJS.ProcessEnv = process.env,
  evidence: ShellEvidence = processEvidence,
  currentPid = process.pid,
): string | null => {
  const home = env.HOME;
  const shell = env.SHELL;
  if (!home || !path.isAbsolute(home) || !shell || !path.isAbsolute(shell) || path.basename(shell) !== 'zsh'
    || env.BALLIN_SHELL_HOME !== home || env.BALLIN_SHELL_CONFIGURED !== shell
    || !/^[1-9]\d*$/u.test(env.BALLIN_SHELL_PID ?? '')) return null;
  const invokingPid = Number(env.BALLIN_SHELL_PID);
  if (!Number.isSafeInteger(invokingPid) || invokingPid === currentPid) return null;
  try {
    let ancestor = currentPid;
    const seen = new Set<number>();
    while (ancestor > 1 && !seen.has(ancestor) && seen.size < 64) {
      seen.add(ancestor);
      const parent = evidence.parent(ancestor);
      if (parent === null) return null;
      ancestor = parent;
      if (ancestor === invokingPid) break;
    }
    if (ancestor !== invokingPid) return null;
    const executable = evidence.executable(invokingPid);
    if (!executable || !path.isAbsolute(executable) || path.basename(executable) !== 'zsh') return null;
    const actual = fs.statSync(executable);
    const configured = fs.statSync(shell);
    if (!actual.isFile() || actual.dev !== configured.dev || actual.ino !== configured.ino) return null;
    const state = env.BALLIN_SHELL_ZDOTDIR_SET;
    if (state !== '' && state !== 'x') return null;
    const directory = state === 'x' ? env.BALLIN_SHELL_ZDOTDIR : home;
    if (!directory || !path.isAbsolute(directory) || /[\r\n\0]/u.test(directory)) return null;
    return directory;
  } catch { return null; }
};

module.exports = { zshStartupDirectory };
if (require.main === module) process.stdout.write(zshStartupDirectory() ?? '');
