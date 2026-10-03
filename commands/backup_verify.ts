const fs = require('fs');
const path = require('path');
const { configuredBackupDestination, sensitiveSourceConsent } = require('./backup_config.ts');
const { observeSnapshotSources, classifySnapshotFileName, normalizeSnapshotInput, snapshotDefinitions, isSnapshotSelected } = require('./backup_snapshots.ts');
const { inspectRepository, assertRepositoryCurrent, repositoryCacheDirectory, repositoryMessages } = require('./backup_repository.ts');
const { compareSnapshotState } = require('./backup_comparison.ts');
const { captureQualifiedCollector, readQualifiedBrewPrefix } = require('./backup_collectors.ts');
const { projectPortablePreferences } = require('../config/portable.ts');
const { makeTempFile, removeTempFile, writeStdoutLine } = require('./commandHelpers.ts');
import type { RepositoryOptions, RepositoryError } from './backup_repository.ts';
import type { AvailableSnapshotObservation, SnapshotDefinition, SnapshotSourceObservation } from './backup_snapshots.ts';

type VerifyOptions = { configPath: string; homeDir: string; cacheRoot: string; env?: NodeJS.ProcessEnv; repository?: RepositoryOptions };
type SourceResult = { name: string; status: 'match' | 'excluded' | 'skip' | 'saved-unverified' | 'unchecked' | 'missing' | 'different' | 'conflict'; detail: string };

// Follow selected dotfile symlinks, but never read a FIFO/device or execute content.
const readRegularFile = (file: string, followSymlink = true): Buffer => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (followSymlink ? 0 : fs.constants.O_NOFOLLOW));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Not a regular file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
};

const readComparisonBase = (root: string, directory: string, name: string): Buffer | undefined => {
  try {
    for (const entry of [root, directory]) {
      if (!fs.lstatSync(entry).isDirectory()) throw new Error('Unsupported cache directory');
    }
    if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error('Unsupported cache file');
    return readRegularFile(path.join(directory, name), false);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
};

const captureCurrent = (source: AvailableSnapshotObservation): Buffer | undefined => {
  const bytes = source.source.kind === 'file'
    ? readRegularFile(source.source.path as string)
    : captureQualifiedCollector(source);
  if (bytes === undefined) return undefined;
  const input = source.definition.inclusionGroup === 'preferences'
    ? Buffer.from(`${JSON.stringify(projectPortablePreferences(JSON.parse(bytes.toString('utf8'))), null, 2)}\n`)
    : bytes;
  const file = makeTempFile('ballin-verify-');
  try {
    fs.writeFileSync(file, input, { mode: 0o600, flag: 'wx' });
    normalizeSnapshotInput(file);
    return fs.readFileSync(file);
  } finally { removeTempFile(file); }
};

const observeCurrent = (source: SnapshotSourceObservation, remote: Buffer | undefined, cacheRoot: string, cacheDir: string): SourceResult => {
  const name = source.definition.name;
  if (source.status === 'excluded-by-policy') return { name, status: 'excluded', detail: 'excluded by local policy' };
  if (source.status === 'absent' || source.status === 'unavailable') {
    return { name, status: remote === undefined ? 'skip' : 'saved-unverified', detail: source.status === 'absent' ? 'source absent' : 'source unavailable' };
  }
  if (source.status === 'discovery-failed') return { name, status: 'unchecked', detail: source.reason === 'unsafe-collector' ? 'collector startup safety is not established' : 'source discovery failed' };
  let local: Buffer | undefined;
  try { local = captureCurrent(source); } catch { return { name, status: 'unchecked', detail: 'source collection or private cleanup failed' }; }
  if (local === undefined) return { name, status: 'unchecked', detail: 'collector startup safety is not established' };
  // Cache failures cannot negate observed local/remote equality.
  if (remote !== undefined && local.equals(remote)) return { name, status: 'match', detail: 'current bytes match' };
  let base: Buffer | undefined;
  try { base = readComparisonBase(cacheRoot, cacheDir, name); } catch {
    return { name, status: remote === undefined ? 'missing' : 'different', detail: 'comparison cache unreadable; conflict diagnosis incomplete' };
  }
  const comparison = compareSnapshotState(base !== undefined, remote !== undefined, false,
    base !== undefined && remote !== undefined && base.equals(remote));
  if (comparison.status === 'conflict') return { name, status: 'conflict', detail: comparison.reason };
  return { name, status: remote === undefined ? 'missing' : 'different', detail: remote === undefined ? 'selected current snapshot is missing' : 'current bytes differ; run `ballin backup` to save the pending change' };
};

const failing = (result: SourceResult): boolean => ['unchecked', 'missing', 'different', 'conflict'].includes(result.status);

const runBackupVerify = (args: string[], options: VerifyOptions): number => {
  const verbose = args.length === 1 && args[0] === '--verbose';
  if (args.length !== 0 && !verbose) {
    writeStdoutLine('Usage: ballin backup verify [--verbose]');
    return 2;
  }
  const problems: string[] = [];
  const results: SourceResult[] = [];
  try {
    const config = JSON.parse(readRegularFile(options.configPath).toString('utf8'));
    const destination = configuredBackupDestination(config);
    if (destination.kind !== 'repository') {
      writeStdoutLine('Backup verification incomplete: configure a private repository with `ballin backup setup`.');
      return 1;
    }
    const includeSensitive = sensitiveSourceConsent(config);
    if (includeSensitive === null || !options.homeDir) {
      writeStdoutLine('Backup verification incomplete: check the local sensitive-source choice and HOME.');
      return 1;
    }
    const inspection = inspectRepository(destination.repository, options.repository);
    if (inspection.status !== 'complete') {
      writeStdoutLine(`Backup verification incomplete: ${repositoryMessages[inspection.problem]}`);
      return 1;
    }
    const read = inspection.read;
    if (![...read.snapshots.keys()].some((name: string) => classifySnapshotFileName(name) === 'current')) {
      problems.push('No usable backup snapshots are saved. Run `ballin backup` to create them.');
    }
    const unexpected = read.revision.entries.filter((entry: { classification: string }) => entry.classification === 'unexpected').length;
    if (unexpected) problems.push(`${unexpected} unexpected repository entries require review with \`ballin backup open\`.`);
    const cacheDir = repositoryCacheDirectory(options.cacheRoot, destination.repository);
    try {
      const sources = observeSnapshotSources({ homeDir: options.homeDir, env: options.env ?? process.env, allowToolExecution: false, readBrewPrefix: readQualifiedBrewPrefix }, includeSensitive);
      for (const source of sources) results.push(observeCurrent(source, read.snapshots.get(source.definition.name), options.cacheRoot, cacheDir));
    } catch {
      problems.push('Current source discovery is incomplete.');
      // A failed observation batch must still account for every policy-selected source.
      results.splice(0, results.length, ...snapshotDefinitions.map((definition: SnapshotDefinition): SourceResult => (
        isSnapshotSelected(definition, includeSensitive)
          ? { name: definition.name, status: 'unchecked', detail: 'source discovery incomplete' }
          : { name: definition.name, status: 'excluded', detail: 'excluded by local policy' }
      )));
    }
    // Even failed local observations must not turn earlier revision facts into current assurance.
    try { assertRepositoryCurrent(read, options.repository); } catch (error) {
      problems.push(repositoryMessages[(error as RepositoryError).problem] ?? 'The final repository check failed.');
    }
    const passed = problems.length === 0 && !results.some(failing);
    writeStdoutLine(passed ? 'Backup matches the current sources checked.' : 'Backup verification incomplete or different.');
    for (const problem of problems) writeStdoutLine(problem);
    for (const result of results) {
      if (verbose || failing(result) || result.status === 'saved-unverified') {
        writeStdoutLine(`${result.name}: ${result.status} (${result.detail}${result.status === 'saved-unverified' ? '; saved snapshot retained, currently unverified' : ''}).`);
      }
    }
    if (results.some((result) => result.status === 'conflict')) {
      writeStdoutLine('Inspect conflicting snapshots with `ballin backup read <file>` or `ballin backup open`; reconcile deliberately before another backup.');
    }
    if (verbose) {
      for (const entry of read.revision.entries) {
        if (entry.classification === 'retired') writeStdoutLine(`${entry.path}: known retired snapshot retained.`);
      }
    }
    return passed ? 0 : 1;
  } catch {
    writeStdoutLine('Backup verification incomplete: unable to read local configuration or backup state.');
    return 1;
  }
};

module.exports = { runBackupVerify };
export type { VerifyOptions };
