const path = require('path');

// Display paths within HOME using ~ without changing paths used for operations.
const terminalPath = (value: string, home = process.env.HOME): string => {
  const absolute = path.resolve(value);
  if (!home || !path.isAbsolute(home)) return absolute;
  const relative = path.relative(home, absolute);
  if (relative === '') return '~';
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    ? `~/${relative}` : absolute;
};

// Emphasis belongs only on human-facing output, never config or snapshot bytes.
const supportsEmphasis = (stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean => (
  Boolean(stream.isTTY) && env.TERM !== 'dumb' && !env.NO_COLOR
);

const terminalEmphasis = (
  text: string,
  kind: 'bold' | 'underline',
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (!supportsEmphasis(stream, env)) return text;
  return `\x1b[${kind === 'bold' ? 1 : 4}m${text}\x1b[0m`;
};

const terminalHeading = (
  text: string,
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (!supportsEmphasis(stream, env)) return `==> ${text}`;
  return `\x1b[34m==>\x1b[1;39m ${text}\x1b[0m`;
};

const terminalCommand = (
  command: string,
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => supportsEmphasis(stream, env)
  ? terminalEmphasis(command, 'bold', stream, env) : `\`${command}\``;

// Explicit references in Ballin-owned prose only. Do not infer commands from
// arbitrary backticks, or pass config values, snapshot bytes or child output.
const terminalCommandReferences = (
  text: string,
  commands: readonly string[],
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => commands.reduce((prose, command) => (
  prose.replaceAll(`\`${command}\``, () => terminalCommand(command, stream, env))
), text);


const terminalColor = (text: string, color: number, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => (
  supportsEmphasis(stream, env) ? `\x1b[${color}m${text}\x1b[0m` : text
);
const terminalUrls = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => (
  text.replace(/https?:\/\/[^\s\x1b]+/gu, (token: string, offset: number) => {
    if (text.slice(0, offset).endsWith('\x1b[34m')) return token;
    const url = token.replace(/[.,;:!?)]+$/u, '');
    return terminalColor(url, 34, stream, env) + token.slice(url.length);
  })
);
const terminalPrompt = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => (
  text.replace(/\[([^\[\]]+)\]/gu, (_match, choices: string) => {
    if (!supportsEmphasis(stream, env)) return `[${choices}]`;
    const parts = choices.split('/').map((choice) => /[A-Z]/u.test(choice) && choice === choice.toUpperCase()
      ? `\x1b[1m${choice}\x1b[22m` : choice);
    return `\x1b[34m[${parts.join('/')}]\x1b[0m`;
  })
);
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '');
const visibleWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stripAnsi(text))) {
    if (/^[\p{Mark}\p{Cf}]*$/u.test(segment)) continue;
    const code = segment.codePointAt(0)!;
    width += /\p{Extended_Pictographic}/u.test(segment) || (code >= 0x1100 && (
      code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3
      || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f
      || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6
      || code >= 0x20000)) ? 2 : 1;
  }
  return width;
};
const terminalProse = (text: string, stream: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => {
  const width = Math.min(80, Math.max(1, stream.columns || 80));
  return terminalUrls(text, stream, env).split('\n').map((paragraph) => {
    const lines: string[] = [];
    let line = '';
    // Explicit references and adjacent punctuation stay copyable, even when one
    // complete reference is wider than the terminal, as in help output.
    const words = paragraph.match(/(?:`[^`]*`|\x1b\[1m[^\x1b]*\x1b\[0m|\S)+/gu) ?? [];
    for (const word of words) {
      if (line && visibleWidth(`${line} ${word}`) > width) { lines.push(line); line = ''; }
      line += `${line ? ' ' : ''}${word}`;
    }
    lines.push(line);
    return lines.join('\n');
  }).join('\n');
};
const terminalError = (text: string, stream: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => (
  terminalProse(`${terminalColor('❌', 31, stream, env)} ${text}`, stream, env)
);
const terminalComplete = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => terminalColor(text, 32, stream, env);

module.exports = {
  terminalPath, terminalEmphasis, terminalHeading, terminalCommand, terminalCommandReferences,
  terminalUrls, terminalPrompt, stripAnsi, visibleWidth, terminalProse, terminalError, terminalComplete,
};
