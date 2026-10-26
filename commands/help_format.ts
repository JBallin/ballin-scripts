// Help-only layout: do not apply to prompts, diagnostics, config or snapshot bytes.
// Syntax in backticks and URLs stays copyable, even when wider than the terminal.
const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/gu, '').length;

const wrapHelpLine = (text: string, width: number, prefix = '', continuation = prefix): string => {
  const words = text.match(/`[^`]*`[.,;:!?)]*|\S+/gu) ?? [];
  const lines: string[] = [];
  let line = prefix;
  let hasWord = false;
  for (const word of words) {
    if (hasWord && visibleWidth(`${line} ${word}`) > width) {
      lines.push(line);
      line = continuation;
      hasWord = false;
    }
    line += `${hasWord ? ' ' : ''}${word}`;
    hasWord = true;
  }
  lines.push(line);
  return lines.join('\n');
};

const formatHelp = (
  text: string,
  stream: { columns?: number } = process.stdout,
): string => {
  const columns = stream.columns;
  const width = columns !== undefined && Number.isFinite(columns) && columns >= 1
    ? Math.min(80, Math.floor(columns)) : 80;
  return text.split('\n').map((line) => {
    // Usage and standalone examples are preformatted. Command-table descriptions
    // wrap at their existing column, or beneath the command on narrow terminals.
    const row = /^( +)(\S+)( {2,})(\S.*)$/u.exec(line);
    if (row) {
      const [, indent, command, gap, description] = row;
      const prefix = `${indent}${command}${gap}`;
      if (width - prefix.length >= 20) {
        return wrapHelpLine(description, width, prefix, ' '.repeat(prefix.length));
      }
      const continuation = `${indent}    `;
      return `${indent}${command}\n${wrapHelpLine(description, width, continuation)}`;
    }
    const bullet = /^([-*] |\d+\. )(.*)$/u.exec(line);
    if (bullet) return wrapHelpLine(bullet[2], width, bullet[1], ' '.repeat(bullet[1].length));
    if (/^\s/u.test(line) || !line) return line;
    return wrapHelpLine(line, width);
  }).join('\n');
};

module.exports = { formatHelp };
