const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

import type { SpawnSyncReturns } from 'child_process';

type DateRange = {
  from: string;
  to: string;
};

type ReportOptions = DateRange & {
  database: string;
  rootDir?: string;
};

type ParsedArgs = {
  database: string;
  from?: string;
  help: boolean;
  to?: string;
};

type D1Row = Record<string, unknown>;
type D1Runner = (sql: string, options: ReportOptions) => D1Row[];
type SpawnRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => SpawnSyncReturns<string>;

type ReportRows = {
  activeInstalls: D1Row[];
  commandStatus: D1Row[];
  runtimeTrends: D1Row[];
};

const defaultDatabase = 'ballin-scripts-analytics';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const reportQueryFiles = {
  activeInstalls: 'report-active-installs.sql',
  commandStatus: 'report-command-status.sql',
  runtimeTrends: 'report-runtime-trends.sql',
};

const usage = [
  'Usage: npm run analytics:report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--database NAME]',
  '',
  'Prints a read-only production D1 report from the existing analytics aggregates.',
].join('\n');
const publicTelemetryCaveat = 'Caveat: analytics are public client telemetry; aggregate counts are directional and not security-trustworthy.';

const dateBucket = (date: Date): string => date.toISOString().slice(0, 10);

const addUtcDays = (dateBucketValue: string, days: number): string => {
  const date = new Date(`${dateBucketValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateBucket(date);
};

const isValidDateBucket = (value: string): boolean => {
  if (!datePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && dateBucket(parsed) === value;
};

const requiredOptionValue = (value: string | undefined, option: string): string => {
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseArgs = (args: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    database: defaultDatabase,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--from') {
      index += 1;
      parsed.from = requiredOptionValue(args[index], arg);
    } else if (arg === '--to') {
      index += 1;
      parsed.to = requiredOptionValue(args[index], arg);
    } else if (arg === '--database') {
      index += 1;
      parsed.database = requiredOptionValue(args[index], arg);
    } else {
      throw new Error(`Unknown analytics report option: ${arg}`);
    }
  }

  return parsed;
};

const dateRangeFromArgs = (args: ParsedArgs, now = new Date()): DateRange => {
  const to = args.to ?? dateBucket(now);
  const from = args.from ?? addUtcDays(to, -29);

  if (!isValidDateBucket(from)) {
    throw new Error('--from must be a valid YYYY-MM-DD date');
  }
  if (!isValidDateBucket(to)) {
    throw new Error('--to must be a valid YYYY-MM-DD date');
  }
  if (from > to) {
    throw new Error('--from must be on or before --to');
  }

  return { from, to };
};

const optionsFromArgs = (args: string[], now = new Date()): ReportOptions & { help: boolean } => {
  const parsed = parseArgs(args);
  if (!parsed.database) {
    throw new Error('--database must not be empty');
  }
  if (parsed.help) {
    return {
      database: parsed.database,
      from: '',
      help: true,
      to: '',
    };
  }

  return {
    ...dateRangeFromArgs(parsed, now),
    database: parsed.database,
    help: false,
  };
};

const queryPath = (rootDir: string, filename: string): string => (
  path.join(rootDir, 'analytics-worker', 'queries', filename)
);

const buildQuery = (template: string, range: DateRange): string => (
  template
    .replaceAll('__FROM_DATE__', range.from)
    .replaceAll('__TO_DATE__', range.to)
);

const loadReportQueries = (options: ReportOptions): Record<keyof typeof reportQueryFiles, string> => {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  return {
    activeInstalls: buildQuery(
      fs.readFileSync(queryPath(rootDir, reportQueryFiles.activeInstalls), 'utf8'),
      options,
    ),
    commandStatus: buildQuery(
      fs.readFileSync(queryPath(rootDir, reportQueryFiles.commandStatus), 'utf8'),
      options,
    ),
    runtimeTrends: buildQuery(
      fs.readFileSync(queryPath(rootDir, reportQueryFiles.runtimeTrends), 'utf8'),
      options,
    ),
  };
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const rowsFromD1Json = (value: unknown): D1Row[] => {
  if (Array.isArray(value)) {
    if (
      value.every(isObject)
      && value.some((item) => (
        Array.isArray(item.results)
        || Array.isArray(item.result)
        || item.success === false
      ))
    ) {
      return value.flatMap((item) => rowsFromD1Json(item));
    }
    return value.filter(isObject);
  }
  if (!isObject(value)) {
    return [];
  }
  if (value.success === false) {
    throw new Error('Wrangler D1 query failed');
  }
  if (Array.isArray(value.results)) {
    return value.results.filter(isObject);
  }
  if (Array.isArray(value.result)) {
    return rowsFromD1Json(value.result);
  }
  return [];
};

const parseD1Json = (stdout: string): D1Row[] => {
  try {
    return rowsFromD1Json(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Wrangler returned invalid JSON');
    }
    throw error;
  }
};

const wranglerArgsFor = (sql: string, options: ReportOptions): string[] => {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  return [
    '--config',
    path.join(rootDir, 'analytics-worker', 'wrangler.toml'),
    'd1',
    'execute',
    options.database,
    '--remote',
    '--json',
    '--command',
    sql,
  ];
};

const wranglerConfigPath = (rootDir: string): string => (
  path.join(rootDir, 'analytics-worker', 'wrangler.toml')
);

const runWrangler = (
  sql: string,
  options: ReportOptions,
  spawnRunner: SpawnRunner = spawnSync,
): D1Row[] => {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  const configPath = wranglerConfigPath(rootDir);
  if (!fs.existsSync(configPath)) {
    throw new Error([
      `Missing analytics Worker config: ${configPath}`,
      'Copy analytics-worker/wrangler.toml.example to analytics-worker/wrangler.toml,',
      'fill in the D1 database_id, and make sure Wrangler is authenticated.',
    ].join('\n'));
  }

  const wranglerArgs = wranglerArgsFor(sql, options);
  let result = spawnRunner('wrangler', wranglerArgs, {
    cwd: rootDir,
    encoding: 'utf8',
  });

  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    result = spawnRunner('npx', ['wrangler', ...wranglerArgs], {
      cwd: rootDir,
      encoding: 'utf8',
    });
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || 'Wrangler D1 query failed';
    throw new Error(message);
  }

  return parseD1Json(result.stdout);
};

const numberValue = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
);

const stringValue = (value: unknown): string => (
  typeof value === 'string' && value.length > 0 ? value : 'unknown'
);

const dateBucketsBetween = (range: DateRange): string[] => {
  const dates: string[] = [];
  for (let current = range.from; current <= range.to; current = addUtcDays(current, 1)) {
    dates.push(current);
  }
  return dates;
};

const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, column) => (
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0))
  ));
  const formatRow = (row: string[]): string => (
    row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  );
  return [
    formatRow(headers),
    formatRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(formatRow),
  ].join('\n');
};

const formatActiveInstalls = (rows: D1Row[], range: DateRange): string => {
  const installsByDate = new Map(rows.map((row) => [
    stringValue(row.date_bucket),
    numberValue(row.active_installs),
  ]));
  const tableRows = dateBucketsBetween(range).map((day) => [
    day,
    String(installsByDate.get(day) ?? 0),
  ]);

  return [
    'Active installs by day',
    table(['date', 'active_installs'], tableRows),
  ].join('\n');
};

const formatCommandStatus = (rows: D1Row[]): string => {
  if (rows.length === 0) {
    return 'Command usage\nNo command events found for this range.';
  }

  const tableRows = rows.map((row) => {
    const total = numberValue(row.total);
    const failures = numberValue(row.failures);
    const failureRate = total === 0 ? '0.0%' : `${((failures / total) * 100).toFixed(1)}%`;
    return [
      stringValue(row.command),
      String(total),
      String(numberValue(row.successes)),
      String(failures),
      String(numberValue(row.unknown)),
      failureRate,
    ];
  });

  return [
    'Command usage',
    table(['command', 'total', 'success', 'failure', 'unknown', 'failure_rate'], tableRows),
  ].join('\n');
};

const formatRuntimeTrends = (rows: D1Row[]): string => {
  if (rows.length === 0) {
    return 'Runtime/version trends\nNo runtime/version events found for this range.';
  }

  const tableRows = rows.map((row) => [
    stringValue(row.date_bucket),
    stringValue(row.app_version),
    stringValue(row.node_major),
    stringValue(row.os),
    stringValue(row.os_version),
    String(numberValue(row.events)),
  ]);

  return [
    'Runtime/version trends',
    table(['date', 'app_version', 'node_major', 'os', 'os_version', 'events'], tableRows),
  ].join('\n');
};

const renderReport = (rows: ReportRows, options: ReportOptions): string => [
  `Analytics report (${options.from} to ${options.to})`,
  publicTelemetryCaveat,
  '',
  formatActiveInstalls(rows.activeInstalls, options),
  '',
  formatCommandStatus(rows.commandStatus),
  '',
  formatRuntimeTrends(rows.runtimeTrends),
  '',
].join('\n');

const generateReport = (options: ReportOptions, runner: D1Runner = runWrangler): string => {
  const queries = loadReportQueries(options);
  return renderReport({
    activeInstalls: runner(queries.activeInstalls, options),
    commandStatus: runner(queries.commandStatus, options),
    runtimeTrends: runner(queries.runtimeTrends, options),
  }, options);
};

const runCli = (args = process.argv.slice(2)): number => {
  try {
    const options = optionsFromArgs(args);
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      return 0;
    }
    process.stdout.write(generateReport(options));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`analytics report: ${message}\n`);
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  buildQuery,
  dateRangeFromArgs,
  defaultDatabase,
  generateReport,
  loadReportQueries,
  optionsFromArgs,
  parseD1Json,
  renderReport,
  runCli,
  runWrangler,
  usage,
  wranglerArgsFor,
};
