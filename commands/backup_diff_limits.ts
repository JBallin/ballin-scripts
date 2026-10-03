const { performance } = require('perf_hooks');
const { runCommand } = require('./commandHelpers.ts');
import type { SpawnSyncOptions } from 'child_process';

const diffLimits = {
  durationMs: 60_000, requestMs: 30_000, streamBytes: 4 * 1024 * 1024,
  aggregateBytes: 16 * 1024 * 1024, requests: 120, hops: 100, entries: 1000,
  blobBytes: 1024 * 1024, renderedBytes: 1024 * 1024,
} as const;
type DiffBudget = { deadline: number; bytes: number; requests: number };
type DiffResult = { status: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
type DiffRunner = (command: string, args: string[], options: SpawnSyncOptions) => DiffResult;
class DiffError extends Error {}
const createDiffBudget = (): DiffBudget => ({ deadline: performance.now() + diffLimits.durationMs, bytes: 0, requests: 0 });
const checkDiffDeadline = (budget: DiffBudget): number => {
  const remaining = Math.floor(budget.deadline - performance.now());
  if (remaining <= 0) throw new DiffError('Inspection exceeded its time limit; no complete comparison is available.');
  return remaining;
};
const runDiffCommand = (
  budget: DiffBudget, command: string, args: string[], options: SpawnSyncOptions, runner: DiffRunner = runCommand,
): DiffResult => {
  const timeout = Math.min(diffLimits.requestMs, checkDiffDeadline(budget));
  if (++budget.requests > diffLimits.requests) throw new DiffError('Inspection exceeded its request limit.');
  if (diffLimits.aggregateBytes - budget.bytes < 2) throw new DiffError('Inspection exceeded its transport budget.');
  // SIGKILL also terminates a child that ignores SIGTERM. Pipes prevent unbounded disk spooling.
  const result = runner(command, args, {
    ...options, stdio: ['pipe', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL',
    maxBuffer: Math.min(diffLimits.streamBytes, Math.floor((diffLimits.aggregateBytes - budget.bytes) / 2)),
    shell: false,
  });
  const stdoutBytes = Buffer.byteLength(result.stdout ?? '');
  const stderrBytes = Buffer.byteLength(result.stderr ?? '');
  budget.bytes += stdoutBytes + stderrBytes;
  if (stdoutBytes > diffLimits.streamBytes || stderrBytes > diffLimits.streamBytes
    || budget.bytes >= diffLimits.aggregateBytes || result.error || result.signal) {
    throw new DiffError('Inspection exceeded a transport limit or the command could not complete.');
  }
  checkDiffDeadline(budget);
  return result;
};

module.exports = { diffLimits, DiffError, createDiffBudget, checkDiffDeadline, runDiffCommand };
export type { DiffBudget, DiffRunner, DiffResult };
