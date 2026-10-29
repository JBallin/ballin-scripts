const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');
const { clearTemporaryStatus } = require('./temporaryStatus.ts');
const { terminalHeading } = require('./terminalStyle.ts');

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
let setupHintPending = false;
const enableSetupCancelHint = (): void => { setupHintPending = true; };
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

const readPromptLine = (prompt: string): PromptLine => {
  if (setupHintPending) {
    setupHintPending = false;
    if (tty.isatty(0) && process.env.BALLIN_CANCEL_HINT_SHOWN !== '1') {
      writeStdoutLine('ℹ️  Ctrl-C to cancel');
      process.env.BALLIN_CANCEL_HINT_SHOWN = '1';
    }
  }
  process.stdout.write(prompt);
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
  if (!tty.isatty(0)) process.stdout.write('\n');
  return { text: Buffer.from(bytes).toString('utf8'), eof: !complete };
};

const readYesNo = (prompt: string, defaultValue = false): boolean | null => {
  while (true) {
    const response = readPromptLine(prompt);
    if (response.eof) return null;
    const answer = parseYesNo(response.text, defaultValue);
    if (answer !== undefined) return answer;
    writeStdoutLine('Please enter yes or no.');
  }
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
  enableSetupCancelHint,
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
