const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

import type { SpawnSyncOptionsWithStringEncoding } from 'child_process';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;

const runCommand = (
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnResult => spawnSync(command, args, {
  encoding: 'utf8',
  ...options,
});

const commandExists = (command: string, options: SpawnOptions = {}): boolean => {
  const result = runCommand('bash', ['-c', `candidate="$(command -v ${command})" && [ -x "$candidate" ]`], {
    stdio: 'ignore',
    ...options,
  });
  return result.status === 0;
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
  makeTempFile,
  progress,
  readCommandOutput,
  removeTempFile,
  runCommand,
  writeStderrLine,
  writeStdoutLine,
};
