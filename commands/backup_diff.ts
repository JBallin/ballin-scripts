const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');
const { classifySnapshotFileName } = require('./backup_snapshots.ts');
const { compareRepositoryRevision, repositoryMessages, RepositoryError } = require('./backup_repository.ts');
const { diffLimits, DiffError, createDiffBudget, checkDiffDeadline, runDiffCommand } = require('./backup_diff_limits.ts');
import type { RepositoryDestination } from './backup_config.ts';
import type { HistoricalComparison, RepositoryOptions, RepositoryError as RepositoryFailure } from './backup_repository.ts';
import type { DiffBudget, DiffRunner } from './backup_diff_limits.ts';

type DiffArguments = { target: string; snapshot?: string };
const parseDiffArguments = (args: string[]): DiffArguments | undefined => {
  if (![1, 3].includes(args.length) || !/^[a-fA-F0-9]{40}$/u.test(args[0])) return undefined;
  if (args.length === 3 && (args[1] !== '--snapshot' || classifySnapshotFileName(args[2]) !== 'current')) return undefined;
  return { target: args[0].toLowerCase(), snapshot: args.length === 3 ? args[2] : undefined };
};
// Escaping backslashes as well makes literal escape spellings distinct from controls.
const escapeDiffOutput = (text: string): string => text.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
  if (character === '\n' || character === '\t') return character;
  if (character === '\\') return '\\\\';
  return `\\u{${character.codePointAt(0)!.toString(16)}}`;
});
const diffSummary = (comparison: HistoricalComparison): string => {
  const lines = [`Saved revision ${comparison.target}`, `Compared with ${comparison.parent ?? 'empty inventory (root revision)'}`];
  if (comparison.changes.length) lines.push(...comparison.changes.map(({ kind, name }) => `  ${kind} ${name}`));
  else lines.push('No supported snapshot changes.');
  if (comparison.retired) lines.push(`Retired entries across these revisions: ${comparison.retired}`);
  if (comparison.unexpected) lines.push(`Unexpected entries across these revisions: ${comparison.unexpected}`);
  return lines.join('\n') + '\n';
};
const renderSnapshotDiff = (
  detail: NonNullable<HistoricalComparison['detail']>, budget: DiffBudget,
  env: NodeJS.ProcessEnv = process.env, runner?: DiffRunner,
): string => {
  for (const bytes of [detail.before, detail.after]) {
    if (bytes === undefined) continue;
    if (bytes.length > diffLimits.blobBytes) throw new DiffError('Snapshot detail exceeds its size limit.');
    try {
      if (bytes.includes(0)) throw new Error('binary');
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch { throw new DiffError('Snapshot detail is binary or invalid UTF-8; a text diff is unavailable.'); }
  }
  checkDiffDeadline(budget);
  let directory: string | undefined;
  let output: string;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-saved-diff-'));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, 'before'), detail.before ?? Buffer.alloc(0), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'after'), detail.after ?? Buffer.alloc(0), { mode: 0o600 });
    const gitEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(gitEnv, {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(directory), GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    });
    const result = runDiffCommand(budget, 'git', [
      '-c', 'core.attributesFile=/dev/null', '--no-pager', 'diff', '--no-index', '--text', '--no-ext-diff', '--no-textconv', '--no-color',
      '--no-renames', '--', 'before', 'after',
    ], { cwd: directory, env: gitEnv }, runner);
    if (result.status !== 0 && result.status !== 1) throw new DiffError('Unable to render snapshot detail.');
    const presence = (bytes?: Buffer): string => bytes === undefined ? 'absent' : `present (${bytes.length} bytes)`;
    output = escapeDiffOutput(`Snapshot ${detail.name}: ${presence(detail.before)} -> ${presence(detail.after)}\n`
      + (result.stdout || 'No text differences.\n'));
    if (Buffer.byteLength(output) > diffLimits.renderedBytes) throw new DiffError('Rendered snapshot detail exceeds its output limit.');
  } finally {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {
        throw new DiffError('Private diff temporary-file cleanup is incomplete.');
      }
    }
  }
  checkDiffDeadline(budget);
  return output;
};
const runBackupDiff = (
  destination: RepositoryDestination, args: DiffArguments, options: RepositoryOptions = {},
): number => {
  try {
    const budget = createDiffBudget();
    const comparison: HistoricalComparison = compareRepositoryRevision(destination, args.target, args.snapshot, options, budget);
    // Build all requested output before writing; refused detail never looks like a complete result.
    const detail = comparison.detail ? renderSnapshotDiff(comparison.detail, budget, options.env, options.runCommand) : '';
    const output = escapeDiffOutput(diffSummary(comparison)) + detail;
    if (Buffer.byteLength(output) > diffLimits.renderedBytes) throw new DiffError('Inspection output exceeds its size limit.');
    checkDiffDeadline(budget);
    process.stdout.write(output);
    return 0;
  } catch (error) {
    const message = error instanceof DiffError ? (error as Error).message
      : error instanceof RepositoryError ? repositoryMessages[(error as RepositoryFailure).problem] : 'Unable to inspect saved backup revisions.';
    process.stderr.write(`ballin backup diff: ${message}\n`);
    return 1;
  }
};

module.exports = { parseDiffArguments, escapeDiffOutput, diffSummary, renderSnapshotDiff, runBackupDiff };
export type { DiffArguments };
