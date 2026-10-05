const fs = require('fs');

let active: { text: string; visible: boolean; prepare: () => void; finish: () => void } | undefined;
const write = (text: string): void => {
  try { fs.writeSync(2, text); } catch { /* Optional feedback must not replace the operation's result. */ }
};

// A static line remains visible while synchronous work blocks the event loop.
const clearTemporaryStatus = (): void => { active?.finish(); };
const prepareForInheritedOutput = (): void => { active?.prepare(); };
const canShowStatus = (text: string): boolean => Boolean(
  process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
  && process.env.TERM !== 'dumb' && !process.env.NO_COLOR
  && !(process.stderr.columns > 0 && process.stderr.columns <= text.length),
);
const withTemporaryStatus = <T>(text: string, action: () => T, options: { retainBeforeInheritedOutput?: boolean } = {}): T => {
  clearTemporaryStatus();
  if (!canShowStatus(text)) return action();
  let retain = false;
  const finish = (): void => {
    if (active?.finish !== finish) return;
    const visible = active.visible;
    active = undefined;
    process.removeListener('exit', finish);
    // Once a child can write, leave its prompts and diagnostics untouched.
    if (visible) write(retain ? '\n' : '\r\x1b[2K');
  };
  const prepare = (): void => {
    retain = options.retainBeforeInheritedOutput ?? false;
    finish();
  };
  active = { text, visible: true, prepare, finish };
  process.once('exit', finish);
  try {
    write(text);
    return action();
  } finally { finish(); }
};

module.exports = { withTemporaryStatus, clearTemporaryStatus, prepareForInheritedOutput };
