const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

import type { SpawnSyncOptionsWithStringEncoding } from 'child_process';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'shell'>;

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

module.exports = {
  commandExists,
  readCommandOutput,
  runCommand,
  writeStdoutLine,
};
