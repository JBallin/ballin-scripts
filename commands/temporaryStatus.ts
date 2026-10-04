const fs = require('fs');

let active: { text: string; visible: boolean; finish: () => void } | undefined;
const write = (text: string): void => {
  try { fs.writeSync(2, text); } catch { /* Optional feedback must not replace the operation's result. */ }
};

// A static line remains visible while synchronous work blocks the event loop.
const clearTemporaryStatus = (): void => { active?.finish(); };
const canShowStatus = (text: string): boolean => Boolean(
  process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
  && process.env.TERM !== 'dumb' && !process.env.NO_COLOR
  && !(process.stderr.columns > 0 && process.stderr.columns <= text.length),
);
// Inherited child output and credential prompts need a completed line, not a cursor to erase.
const writeInteractiveStatusLine = (text: string): void => {
  clearTemporaryStatus();
  if (canShowStatus(text)) write(`${text}\n`);
};
const withTemporaryStatus = <T>(text: string, action: () => T): T => {
  clearTemporaryStatus();
  if (!canShowStatus(text)) return action();
  const finish = (): void => {
    if (active?.finish !== finish) return;
    const visible = active.visible;
    active = undefined;
    process.removeListener('exit', finish);
    if (visible) write('\r\x1b[2K');
  };
  active = { text, visible: true, finish };
  process.once('exit', finish);
  try {
    write(text);
    return action();
  } finally { finish(); }
};

module.exports = { withTemporaryStatus, clearTemporaryStatus, writeInteractiveStatusLine };
