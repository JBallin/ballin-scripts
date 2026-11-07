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
const terminalUrls = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => {
  let linked = false;
  return text.split(/(\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/gu).map((part) => {
    if (part.startsWith('\x1b]8;')) {
      const payload = part.slice(4, part.endsWith('\x07') ? -1 : -2);
      linked = payload.slice(payload.indexOf(';') + 1) !== '';
      return part;
    }
    if (linked) return part;
    return part.replace(/https?:\/\/[^\s\x1b]+/gu, (token: string, offset: number) => {
      if (part.slice(0, offset).endsWith('\x1b[34m')) return token;
      const url = token.replace(/[.,;:!?)]+$/u, '');
      return terminalColor(url, 34, stream, env) + token.slice(url.length);
    });
  }).join('');
};
// Ballin-owned prose only; never pass config values, snapshots or child output.
const terminalMarkers = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => {
  const colors: Record<string, number> = { '?': 32, '!': 33, i: 34, '✓': 32, '✗': 31 };
  return text.replace(/(^|\n)([?!i✓✗])(?= )/gu, (_match, start: string, marker: string) => (
    start + (supportsEmphasis(stream, env) ? `\x1b[${marker === '?' ? 1 : 0};${colors[marker]}m${marker}\x1b[0m` : marker)
  ));
};
const terminalPrompt = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => {
  const leading = text.match(/^\n*/u)![0];
  return leading + terminalMarkers('? ', stream, env) + text.slice(leading.length);
};
const terminalChoice = (label: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => (
  terminalColor(label, 36, stream, env)
);
// Strip owned SGR and OSC 8 wrappers, retaining their visible labels for width.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/gu, '');
const documentationRow = (text: string): RegExpExecArray | null => /^i ([^:\n]+): ((?:https?:\/\/|getballin\.com\/)\S*)$/u.exec(stripAnsi(text));
const isDocumentationRow = (text: string): boolean => documentationRow(text) !== null;
const supportsHyperlinks = (stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean => {
  if (!supportsEmphasis(stream, env) || !env.TERM || !/^(?:xterm|wezterm)(?:-|$)/u.test(env.TERM)
    || env.TMUX || env.STY || env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  if (env.TERM_PROGRAM === 'iTerm.app') {
    const version = /^(\d{1,3})\.(\d{1,3})(?:\.\d{1,5})?(?:[a-z][a-z0-9.-]*)?$/iu.exec(env.TERM_PROGRAM_VERSION ?? '');
    return Boolean(version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 1)));
  }
  return env.TERM_PROGRAM === 'WezTerm' && /^\d{8}-\d{6}-[a-f0-9]+$/iu.test(env.TERM_PROGRAM_VERSION ?? '');
};
const terminalDocumentation = (
  label: string, url: string,
  stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env,
): string => {
  const safeLabel = label.replace(/[\x00-\x1f\x7f-\x9f]/gu, '');
  const display = url.replace(/^https?:\/\//u, '').replace(/[\x00-\x1f\x7f-\x9f]/gu, '');
  if (['getballin.com', 'getballin.com/', 'https://getballin.com', 'https://getballin.com/'].includes(url)) {
    const address = env.TERM_PROGRAM === 'Apple_Terminal' ? 'getballin.com' : 'getballin.com/';
    return terminalMarkers('i ', stream, env) + `${safeLabel}: ` + terminalColor(address, 34, stream, env);
  }
  let target: string | undefined;
  if (!/[\x00-\x20\x7f-\x9f]/u.test(url) && safeLabel === label) {
    try {
      const parsed = new URL(url.includes('://') ? url : 'https://' + url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) target = parsed.href;
    } catch { /* Invalid targets retain a visible fallback, never a control sequence. */ }
  }
  const link = target && supportsHyperlinks(stream, env)
    ? `\x1b]8;;${target}\x1b\\${terminalColor(safeLabel, 34, stream, env)}\x1b]8;;\x1b\\`
    : `${safeLabel}: ${display}`;
  return terminalMarkers('i ', stream, env) + link;
};
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
const terminalProse = (text: string, stream: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env, options: { colorUrls?: boolean } = {}): string => {
  const width = Math.min(80, Math.max(1, stream.columns || 80));
  return text.split('\n').map((raw) => {
    const documentation = options.colorUrls === false ? null : documentationRow(raw);
    if (documentation) return terminalDocumentation(documentation[1], documentation[2], stream, env);
    const paragraph = terminalMarkers(options.colorUrls === false ? raw : terminalUrls(raw, stream, env), stream, env);
    if (paragraph.includes('\x1b]8;')) return paragraph;
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
  terminalProse(`✗ ${text}`, stream, env)
);
const terminalComplete = (text: string, stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string => terminalMarkers(`✓ ${text}`, stream, env);

module.exports = {
  terminalPath, terminalEmphasis, terminalHeading, terminalCommand, terminalCommandReferences,
  terminalUrls, isDocumentationRow, supportsHyperlinks, terminalDocumentation, terminalMarkers, terminalPrompt, terminalChoice, supportsEmphasis, stripAnsi, visibleWidth, terminalProse, terminalError, terminalComplete,
};
