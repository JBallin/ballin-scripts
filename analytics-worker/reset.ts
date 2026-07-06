const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

import type { SpawnSyncReturns } from 'child_process';

type ResetOptions = {
  confirm?: string;
  database: string;
  dryRun: boolean;
  help: boolean;
  rootDir?: string;
};

type D1Row = Record<string, unknown>;
type D1Runner = (sql: string, options: ResetOptions) => D1Row[];
type SpawnRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => SpawnSyncReturns<string>;

const defaultDatabase = 'ballin-scripts-analytics';
const confirmationPhrase = 'RESET_ANALYTICS_AGGREGATES';
const aggregateTables = [
  'install_days',
  'command_events_daily',
  'version_events_daily',
] as const;

const usage = [
  'Usage: node analytics-worker/reset.ts --dry-run [--database NAME]',
  `       node analytics-worker/reset.ts --confirm ${confirmationPhrase} [--database NAME]`,
  '',
  'Prints row counts or clears the production analytics aggregate tables.',
].join('\n');

const requiredOptionValue = (value: string | undefined, option: string): string => {
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseArgs = (args: string[]): ResetOptions => {
  const parsed: ResetOptions = {
    database: defaultDatabase,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--confirm') {
      index += 1;
      parsed.confirm = requiredOptionValue(args[index], arg);
    } else if (arg === '--database') {
      index += 1;
      parsed.database = requiredOptionValue(args[index], arg);
    } else {
      throw new Error(`Unknown analytics reset option: ${arg}`);
    }
  }

  if (!parsed.database) {
    throw new Error('--database must not be empty');
  }
  if (parsed.help) {
    return parsed;
  }
  if (parsed.dryRun && parsed.confirm) {
    throw new Error('Choose either --dry-run or --confirm, not both');
  }
  if (!parsed.dryRun && parsed.confirm !== confirmationPhrase) {
    throw new Error(`Refusing to reset analytics without --confirm ${confirmationPhrase}`);
  }

  return parsed;
};

const wranglerConfigPath = (rootDir: string): string => (
  path.join(rootDir, 'analytics-worker', 'wrangler.toml')
);

const countSql = aggregateTables.map((tableName) => (
  `SELECT '${tableName}' AS table_name, count(*) AS rows FROM ${tableName}`
)).join('\nUNION ALL\n');

const resetSql = aggregateTables
  .map((tableName) => `DELETE FROM ${tableName};`)
  .join('\n');

const wranglerArgsFor = (sql: string, options: ResetOptions): string[] => {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  return [
    '--config',
    wranglerConfigPath(rootDir),
    'd1',
    'execute',
    options.database,
    '--remote',
    '--json',
    '--command',
    sql,
  ];
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

const runWrangler = (
  sql: string,
  options: ResetOptions,
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

const formatCounts = (rows: D1Row[]): string => {
  const counts = new Map(rows.map((row) => [
    stringValue(row.table_name),
    numberValue(row.rows),
  ]));
  return aggregateTables
    .map((tableName) => `${tableName}: ${counts.get(tableName) ?? 0}`)
    .join('\n');
};

const resetAnalytics = (options: ResetOptions, runner: D1Runner = runWrangler): string => {
  const beforeRows = runner(countSql, options);
  if (options.dryRun) {
    return [
      'Analytics aggregate rows',
      formatCounts(beforeRows),
      '',
    ].join('\n');
  }

  runner(resetSql, options);
  const afterRows = runner(countSql, options);
  return [
    'Analytics aggregate rows before reset',
    formatCounts(beforeRows),
    '',
    'Analytics aggregate rows after reset',
    formatCounts(afterRows),
    '',
  ].join('\n');
};

const runCli = (args = process.argv.slice(2)): number => {
  try {
    const options = parseArgs(args);
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      return 0;
    }
    process.stdout.write(resetAnalytics(options));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`analytics reset: ${message}\n`);
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  aggregateTables,
  confirmationPhrase,
  countSql,
  defaultDatabase,
  parseArgs,
  parseD1Json,
  resetAnalytics,
  resetSql,
  runCli,
  runWrangler,
  usage,
  wranglerArgsFor,
};
