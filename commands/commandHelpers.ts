const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');
const { clearTemporaryStatus } = require('./temporaryStatus.ts');
const { terminalHeading, terminalPrompt, terminalChoice, supportsEmphasis, stripAnsi, visibleWidth } = require('./terminalStyle.ts');

import type { SpawnSyncOptionsWithStringEncoding } from 'child_process';

type SpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'shell'>;
type PromptLine = { text: string; eof: boolean };
type PromptInputState = 'open' | 'ended' | 'failed';
let inputState: PromptInputState = 'open';
const promptInputState = (): PromptInputState => inputState;

// A complete answer is distinct from EOF, including EOF after partial input.
const parseYesNo = (text: string, defaultValue: boolean): boolean | undefined => {
  const answer = text.trim().toLowerCase();
  if (!answer) return defaultValue;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return undefined;
};

const commandPermissionDeniedStatus = 126;
const commandNotFoundStatus = 127;

const runCommand = (
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnResult => {
  const spawn = (): SpawnResult => spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    shell: false,
  });
  const stdio = options.stdio;
  if (stdio === 'inherit' || (Array.isArray(stdio) && stdio.slice(1).some((entry) => entry === 'inherit' || entry === 1 || entry === 2))) {
    clearTemporaryStatus();
  }
  return spawn();
};

const runNodeScript = (
  scriptPath: string,
  options: SpawnOptions = {},
): SpawnResult => spawnSync(process.execPath, [scriptPath], {
  ...options,
  encoding: 'utf8',
  shell: false,
});

const isExecutable = (candidate: string): boolean => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const commandExists = (command: string, options: SpawnOptions = {}): boolean => {
  if (command.includes(path.sep)) {
    return isExecutable(command);
  }

  const envPath = options.env?.PATH ?? process.env.PATH ?? '';
  return envPath
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => isExecutable(path.join(directory, command)));
};

const readCommandOutput = (
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): string | null => {
  const result = runCommand(command, args, options);
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout;
};

const writeStdoutLine = (text = ''): void => {
  clearTemporaryStatus();
  process.stdout.write(`${text}\n`);
};

const writeStderrLine = (text = ''): void => {
  clearTemporaryStatus();
  process.stderr.write(`${text}\n`);
};

class CommandInterrupted extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Interrupted. Earlier completed changes remain.');
    this.status = status;
  }
}
const rethrowInterruption = (error: unknown): void => {
  if (error instanceof CommandInterrupted) throw error;
};
const requireUninterrupted = (result: { signal?: string | null; status: number | null; error?: unknown }): void => {
  if (result.error) return; // Timeouts/resource-limit kills retain their actual error classification.
  const number = result.signal && ['SIGINT', 'SIGTERM'].includes(result.signal) ? os.constants.signals[result.signal] : undefined;
  if (typeof number === 'number') throw new CommandInterrupted(128 + number);
  if (result.status === 130 || result.status === 143) throw new CommandInterrupted(result.status);
};

type FixedChoiceLabel = (text: string) => string | undefined;
type PromptLayout = { rows: number; columns: number; echo: boolean };
const promptLayout = (): PromptLayout | undefined => {
  if (!supportsEmphasis(process.stdout, process.env) || !tty.isatty(0)) return;
  try {
    const input = fs.fstatSync(0), output = fs.fstatSync(1);
    if (!input.isCharacterDevice() || !output.isCharacterDevice() || input.rdev !== output.rdev) return;
    // Read metadata only. Never change terminal modes or initialize process.stdin.
    const result = runCommand('/bin/stty', ['-a'], { stdio: [0, 'pipe', 'ignore'], timeout: 1000 });
    if (result.error) return;
    requireUninterrupted(result);
    if (result.status !== 0) return;
    const flags = result.stdout;
    const row = /\brows\s*=?\s*(\d+)|(\d+)\s+rows\b/u.exec(flags);
    const column = /\bcolumns\s*=?\s*(\d+)|(\d+)\s+columns\b/u.exec(flags);
    const echo = /(?:^|[\s;])(-?echo)(?=[\s;]|$)/u.exec(flags);
    if (!row || !column || !echo || !/(?:^|[\s;])icanon(?=[\s;]|$)/u.test(flags)
      || !/(?:^|[\s;])onlcr(?=[\s;]|$)/u.test(flags)) return;
    const rows = Number(row[1] || row[2]), columns = Number(column[1] || column[2]);
    if (rows > 1 && columns > 0) return { rows, columns, echo: echo[1] === 'echo' };
  } catch (error) { rethrowInterruption(error); }
};
const promptInputIdle = (): boolean => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BASH_FUNC_')));
  const result = runCommand('/bin/zsh', ['-d', '-f', '-c', 'zmodload zsh/zselect || exit 2; zselect -r 0 -t 0'], {
    env: { ...env, BASH_ENV: '', ENV: '', ZDOTDIR: '' }, stdio: [0, 'ignore', 'ignore'], timeout: 1000,
  });
  if (result.error) return false;
  requireUninterrupted(result);
  // The native macOS shell polls readiness without consuming an input byte.
  return result.status === 1;
};
const confirmPromptChoice = (prompt: string, answer: string, label: string, layout: PromptLayout): void => {
  if (!promptInputIdle()) return;
  const current = promptLayout();
  if (!current || current.columns !== layout.columns || current.rows !== layout.rows || current.echo !== layout.echo) return;
  const lastLine = prompt.slice(prompt.lastIndexOf('\n') + 1);
  // Do not guess how a terminal echoed control bytes, or reach outside the
  // visible prompt region. Free text never enters this fixed-choice path.
  if (/[\x00-\x1f\x7f]/u.test(stripAnsi(lastLine) + answer)) return;
  const rows = Math.max(1, Math.ceil((visibleWidth(lastLine) + (layout.echo ? visibleWidth(answer) : 0)) / layout.columns));
  if (rows >= layout.rows) return;
  process.stdout.write(`\x1b[${rows}A\r\x1b[J${lastLine}${terminalChoice(label)}\n`);
};

const readPromptLine = (prompt: string, fixedChoiceLabel?: FixedChoiceLabel): PromptLine => {
  const rendered = terminalPrompt(prompt);
  const candidateLayout = fixedChoiceLabel ? promptLayout() : undefined;
  const layout = candidateLayout && promptInputIdle() ? candidateLayout : undefined;
  process.stdout.write(rendered);
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  let complete = false;
  // Keep fd 0 synchronous: constructing process.stdin can make empty reads fail
  // with EAGAIN. Terminal eligibility checks must use tty.isatty(0) instead.
  try {
    while (fs.readSync(0, byte, 0, 1, null) !== 0) {
      if (byte[0] === 10) {
        if (bytes.at(-1) === 13) bytes.pop(); // CRLF delimiter, not embedded path bytes.
        complete = true;
        break;
      }
      bytes.push(byte[0]);
    }
  } catch (error) {
    inputState = 'failed';
    // Do not expose arbitrary error messages, paths, or prompt answers.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const knownCode = typeof code === 'string' && Object.hasOwn(os.constants.errno, code) ? code : 'unknown';
    try { writeStderrLine(`Unable to read prompt input (stdin read: ${knownCode}).`); } catch {
      // An unavailable diagnostic stream must not replace the input failure.
    }
    throw error;
  }
  if (!complete) inputState = 'ended';
  if (!tty.isatty(0) || layout?.echo === false) process.stdout.write('\n');
  const text = Buffer.from(bytes).toString('utf8');
  const label = complete && layout ? fixedChoiceLabel?.(text) : undefined;
  if (label && layout) confirmPromptChoice(rendered, text, label, layout);
  return { text, eof: !complete };
};

const readYesNo = (prompt: string, defaultValue = false): boolean | null => {
  while (true) {
    const response = readPromptLine(prompt, (text) => {
      const answer = parseYesNo(text, defaultValue);
      return answer === undefined ? undefined : answer ? 'Yes' : 'No';
    });
    if (response.eof) return null;
    const answer = parseYesNo(response.text, defaultValue);
    if (answer !== undefined) return answer;
    writeStdoutLine('Please enter yes or no.');
  }
};

const progress = (text: string, leadingNewline = true): void => {
  process.stdout.write(`${leadingNewline ? '\n' : ''}${terminalHeading(text)}\n`);
};

const reportSpawnError = (command: string, error: Error): number => {
  const errorCode = (error as { code?: string }).code;
  if (errorCode === 'EACCES') {
    writeStderrLine(`${command}: Permission denied`);
    return commandPermissionDeniedStatus;
  }
  if (errorCode === 'ENOENT') {
    writeStderrLine(`${command}: command not found`);
    return commandNotFoundStatus;
  }
  writeStderrLine(error.message);
  return 1;
};

const spawnResultStatus = (result: SpawnResult): number => {
  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    if (typeof signalNumber === 'number') {
      return 128 + signalNumber;
    }
  }
  return result.status ?? 1;
};

const runVisibleCommand = (
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): number => {
  const result = runCommand(command, args, { ...options, stdio: 'inherit' });
  if (result.error) {
    return reportSpawnError(command, result.error);
  }
  return spawnResultStatus(result);
};

const makeTempFile = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(directory, 'output');
};

const removeTempFile = (filePath: string): void => {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
};

module.exports = {
  commandExists,
  isDirectory,
  makeTempFile,
  progress,
  readCommandOutput,
  readPromptLine,
  readYesNo,
  parseYesNo,
  promptInputState,
  CommandInterrupted,
  rethrowInterruption,
  requireUninterrupted,
  reportSpawnError,
  removeTempFile,
  runCommand,
  runNodeScript,
  runVisibleCommand,
  spawnResultStatus,
  writeStderrLine,
  writeStdoutLine,
};
