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

module.exports = { terminalPath, terminalEmphasis, terminalHeading, terminalCommand, terminalCommandReferences };
