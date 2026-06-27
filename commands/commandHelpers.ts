const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

import type { SpawnSyncOptionsWithStringEncoding } from 'child_process';

type SpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'shell'>;

const commandPermissionDeniedStatus = 126;
const commandNotFoundStatus = 127;

const runCommand = (
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnResult => spawnSync(command, args, {
  encoding: 'utf8',
  ...options,
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
  process.stdout.write(`${text}\n`);
};

const writeStderrLine = (text = ''): void => {
  process.stderr.write(`${text}\n`);
};

const progress = (text: string): void => {
  process.stdout.write(`\n==> ${text}\n`);
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

const ensureDir = (directory: string): void => {
  fs.mkdirSync(directory, { recursive: true });
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
  ensureDir,
  isDirectory,
  makeTempFile,
  progress,
  readCommandOutput,
  reportSpawnError,
  removeTempFile,
  runCommand,
  spawnResultStatus,
  writeStderrLine,
  writeStdoutLine,
};
