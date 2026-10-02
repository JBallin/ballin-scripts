// Emphasis belongs only on human-facing output, never config or snapshot bytes.
const terminalEmphasis = (
  text: string,
  kind: 'bold' | 'underline',
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (!stream.isTTY || env.TERM === 'dumb' || Boolean(env.NO_COLOR)) return text;
  return `\x1b[${kind === 'bold' ? 1 : 4}m${text}\x1b[0m`;
};

module.exports = { terminalEmphasis };
