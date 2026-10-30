// Help-only layout: do not apply to prompts, diagnostics, config or snapshot bytes.
// Syntax in backticks and URLs stays copyable, even when wider than the terminal.
const { terminalEmphasis } = require('./terminalStyle.ts');
const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/gu, '').length;

const wrapHelpWords = (words: string[], width: number, prefix = '', continuation = prefix, suffix = ''): string => {
  const lines: string[] = [];
  let line = prefix;
  let hasWord = false;
  for (const [index, word] of words.entries()) {
    const ending = index < words.length - 1 ? suffix : '';
    if (hasWord && visibleWidth(`${line} ${word}${ending}`) > width) {
      lines.push(line + suffix);
      line = continuation;
      hasWord = false;
    }
    line += `${hasWord ? ' ' : ''}${word}`;
    hasWord = true;
  }
  lines.push(line);
  return lines.join('\n');
};

const wrapHelpLine = (text: string, width: number, prefix = '', continuation = prefix): string => (
  wrapHelpWords(text.match(/`[^`]*`[.,;:!?)]*|\S+/gu) ?? [], width, prefix, continuation)
);

// Keep optional argument groups together, including config's [get [key]].
const synopsisWords = (text: string): string[] => text.match(/\[(?:[^\[\]]|\[[^\[\]]*\])*\]|\S+/gu) ?? [];

const formatHelp = (
  text: string,
  stream: { columns?: number; isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const columns = stream.columns;
  const width = columns !== undefined && Number.isFinite(columns) && columns >= 1
    ? Math.min(80, Math.floor(columns)) : 80;
  const bold = (value: string): string => terminalEmphasis(value, 'bold', stream, env);
  const emphasizeIndented = (value: string): string => value.split('\n').map((line) => (
    line.replace(/^( *)(.*)$/u, (_match, indent: string, body: string) => indent + bold(body))
  )).join('\n');
  let inUsage = false;
  let usageIndent = '       ';
  return text.split('\n').map((line) => {
    const usage = /^Usage: (.+)$/u.exec(line);
    if (usage) {
      inUsage = true;
      usageIndent = width >= 'Usage: ballin'.length ? '       ' : '    ';
      if (usageIndent.length === 4) return `${bold('Usage:')}\n${emphasizeIndented(wrapHelpWords(synopsisWords(usage[1]), width, usageIndent))}`;
      const wrapped = wrapHelpWords(synopsisWords(usage[1]), width, 'Usage: ', usageIndent).split('\n');
      return `${bold('Usage:')} ${bold(wrapped[0].slice(7))}${wrapped.length > 1 ? '\n' + emphasizeIndented(wrapped.slice(1).join('\n')) : ''}`;
    }
    if (!line) { inUsage = false; return line; }
    // Wrap syntax at argument boundaries. Shell continuations keep concrete
    // examples copyable rather than splitting filenames or option names.
    if (/^ +ballin(?: |$)/u.test(line)) {
      const indent = inUsage ? usageIndent : line.match(/^ +/u)![0];
      const text = line.trimStart();
      return inUsage
        ? emphasizeIndented(wrapHelpWords(synopsisWords(text), width, indent))
        : wrapHelpWords(text.match(/'[^']*'|"[^"]*"|\S+/gu) ?? [], width, indent, indent + '    ', ' \\');
    }
    inUsage = false;
    // Table terms may include argument syntax. Descriptions align at their
    // source column, or move below the term when the terminal is narrow.
    const row = /^( +)(\S.*?)( {2,})(\S.*)$/u.exec(line);
    if (row) {
      const [, indent, command, gap, description] = row;
      const prefix = `${indent}${command}${gap}`;
      if (width - prefix.length >= 20) {
        return wrapHelpLine(description, width, prefix, ' '.repeat(prefix.length))
          .replace(prefix, `${indent}${bold(command)}${gap}`);
      }
      const continuation = `${indent}    `;
      return `${indent}${bold(command)}\n${wrapHelpLine(description, width, continuation)}`;
    }
    const heading = /^([A-Z][A-Za-z /-]*:)(?: (.*))?$/u.exec(line);
    if (heading) return wrapHelpLine(line, width).replace(heading[1], bold(heading[1]));
    const bullet = /^([-*] |\d+\. )(.*)$/u.exec(line);
    if (bullet) return wrapHelpLine(bullet[2], width, bullet[1], ' '.repeat(bullet[1].length));
    if (/^\s/u.test(line) || !line) return line;
    return wrapHelpLine(line, width);
  }).join('\n');
};

module.exports = { formatHelp };
