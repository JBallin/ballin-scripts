const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
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
  wranglerArgsFor,
} = require('../analytics-worker/reset.ts');

type D1Row = Record<string, unknown>;
type SpawnCall = {
  args: string[];
  command: string;
};

const d1Success = (rows: D1Row[] = []) => ({
  error: undefined,
  output: [],
  pid: 1,
  signal: null,
  status: 0,
  stderr: '',
  stdout: JSON.stringify([{ results: rows, success: true }]),
});

describe('analytics D1 reset', () => {
  it('parses dry-run, confirmation, and custom database options', () => {
    assert.deepEqual(parseArgs(['--dry-run']), {
      database: defaultDatabase,
      dryRun: true,
      help: false,
    });

    assert.deepEqual(parseArgs([
      '--confirm',
      confirmationPhrase,
      '--database',
      'custom-db',
    ]), {
      confirm: confirmationPhrase,
      database: 'custom-db',
      dryRun: false,
      help: false,
    });
  });

  it('requires explicit confirmation before deleting analytics aggregates', () => {
    assert.throws(() => parseArgs([]), `Refusing to reset analytics without --confirm ${confirmationPhrase}`);
    assert.throws(() => parseArgs(['--confirm', 'DELETE']), `Refusing to reset analytics without --confirm ${confirmationPhrase}`);
    assert.throws(() => parseArgs(['--dry-run', '--confirm', confirmationPhrase]), 'Choose either --dry-run or --confirm, not both');
  });

  it('rejects missing option values and unknown options', () => {
    assert.throws(() => parseArgs(['--database']), '--database requires a value');
    assert.throws(() => parseArgs(['--confirm']), '--confirm requires a value');
    assert.throws(() => parseArgs(['--dry-run', '--unknown']), 'Unknown analytics reset option: --unknown');
  });

  it('prints help without requiring dry-run or confirmation', () => {
    assert.deepEqual(parseArgs(['--help']), {
      database: defaultDatabase,
      dryRun: false,
      help: true,
    });
  });

  it('prints aggregate counts without deleting during dry-run', () => {
    const sqlStatements: string[] = [];
    const output = resetAnalytics({
      database: defaultDatabase,
      dryRun: true,
      help: false,
    }, (sql: string): D1Row[] => {
      sqlStatements.push(sql);
      return [
        { rows: 2, table_name: 'install_days' },
        { rows: 3, table_name: 'command_events_daily' },
        { rows: 4, table_name: 'version_events_daily' },
      ];
    });

    assert.deepEqual(sqlStatements, [countSql]);
    assert.include(output, 'Analytics aggregate rows');
    assert.include(output, 'install_days: 2');
    assert.include(output, 'command_events_daily: 3');
    assert.include(output, 'version_events_daily: 4');
  });

  it('normalizes malformed and missing aggregate counts to safe zero values', () => {
    const output = resetAnalytics({
      database: defaultDatabase,
      dryRun: true,
      help: false,
    }, () => [
      { rows: '2', table_name: 'install_days' },
      { rows: Infinity, table_name: '' },
    ]);

    assert.include(output, 'install_days: 2');
    assert.include(output, 'command_events_daily: 0');
    assert.include(output, 'version_events_daily: 0');
  });

  it('deletes only the known aggregate tables after confirmation', () => {
    const sqlStatements: string[] = [];
    const output = resetAnalytics({
      confirm: confirmationPhrase,
      database: defaultDatabase,
      dryRun: false,
      help: false,
    }, (sql: string): D1Row[] => {
      sqlStatements.push(sql);
      if (sql === countSql && sqlStatements.length === 1) {
        return [
          { rows: 2, table_name: 'install_days' },
          { rows: 3, table_name: 'command_events_daily' },
          { rows: 4, table_name: 'version_events_daily' },
        ];
      }
      return aggregateTables.map((tableName: string) => ({
        rows: 0,
        table_name: tableName,
      }));
    });

    assert.deepEqual(sqlStatements, [countSql, resetSql, countSql]);
    assert.include(resetSql, 'DELETE FROM install_days;');
    assert.include(resetSql, 'DELETE FROM command_events_daily;');
    assert.include(resetSql, 'DELETE FROM version_events_daily;');
    assert.notMatch(resetSql, /\bDROP\b/i);
    assert.include(output, 'Analytics aggregate rows before reset');
    assert.include(output, 'install_days: 2');
    assert.include(output, 'Analytics aggregate rows after reset');
    assert.include(output, 'version_events_daily: 0');
  });

  it('builds remote JSON Wrangler D1 execute arguments', () => {
    const args = wranglerArgsFor('SELECT 1', {
      database: 'example-db',
      dryRun: true,
      help: false,
      rootDir: '/repo',
    });

    assert.deepEqual(args, [
      '--config',
      '/repo/analytics-worker/wrangler.toml',
      'd1',
      'execute',
      'example-db',
      '--remote',
      '--json',
      '--command',
      'SELECT 1',
    ]);
  });

  it('explains the required local Wrangler config before running commands', () => {
    const calls: SpawnCall[] = [];

    assert.throws(() => {
      runWrangler('SELECT 1', {
        database: defaultDatabase,
        dryRun: true,
        help: false,
        rootDir: '/repo',
      }, (command: string, args: string[]) => {
        calls.push({ args, command });
        return d1Success();
      });
    }, 'Missing analytics Worker config: /repo/analytics-worker/wrangler.toml');

    assert.deepEqual(calls, []);
  });

  it('falls back to npx --yes wrangler when wrangler is unavailable', () => {
    const calls: SpawnCall[] = [];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-reset-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');
    const options = {
      database: defaultDatabase,
      dryRun: true,
      help: false,
      rootDir,
    };
    const wranglerArgs = wranglerArgsFor('SELECT 1', options);

    const rows = runWrangler('SELECT 1', options, (command: string, args: string[]) => {
      calls.push({ args, command });
      if (command === 'wrangler') {
        return {
          ...d1Success(),
          error: Object.assign(new Error('missing wrangler'), { code: 'ENOENT' }),
        };
      }
      return d1Success([{ rows: 1, table_name: 'install_days' }]);
    });

    assert.deepEqual(calls, [
      { args: wranglerArgs, command: 'wrangler' },
      { args: ['--yes', 'wrangler', ...wranglerArgs], command: 'npx' },
    ]);
    assert.deepEqual(rows, [{ rows: 1, table_name: 'install_days' }]);
  });

  it('normalizes supported Wrangler JSON shapes and rejects malformed results', () => {
    assert.deepEqual(parseD1Json(JSON.stringify([{ rows: 1 }, null])), [{ rows: 1 }]);
    assert.deepEqual(parseD1Json(JSON.stringify({
      result: [{ results: [{ rows: 2 }], success: true }],
    })), [{ rows: 2 }]);
    assert.deepEqual(parseD1Json('null'), []);
    assert.deepEqual(parseD1Json('{}'), []);
    assert.throws(() => parseD1Json(JSON.stringify([{ success: false }])), 'Wrangler D1 query failed');
    assert.throws(() => parseD1Json('{'), 'Wrangler returned invalid JSON');
  });

  it('surfaces reset spawn errors and stderr/stdout/default failure messages', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-reset-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');
    const options = { database: defaultDatabase, dryRun: true, help: false, rootDir };

    assert.throws(() => runWrangler('SELECT 1', options, () => ({
      ...d1Success(),
      error: new Error('spawn denied'),
    })), 'spawn denied');
    assert.throws(() => runWrangler('SELECT 1', options, () => ({
      ...d1Success(),
      status: 1,
      stderr: 'reset denied',
    })), 'reset denied');
    assert.throws(() => runWrangler('SELECT 1', options, () => ({
      ...d1Success(),
      status: 1,
      stdout: 'structured reset failure',
    })), 'structured reset failure');
    assert.throws(() => runWrangler('SELECT 1', options, () => ({
      ...d1Success(),
      status: null,
      stdout: '',
    })), 'Wrangler D1 query failed');
  });

  it('handles reset CLI help, dry-run success, and validation failures through injected boundaries', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writeOut = (text: string) => stdout.push(text);
    const writeError = (text: string) => stderr.push(text);
    const runner = (): D1Row[] => [{ rows: 3, table_name: 'install_days' }];

    assert.equal(runCli(['-h'], runner, writeOut, writeError), 0);
    assert.include(stdout.pop(), 'Usage: node analytics-worker/reset.ts');
    assert.equal(runCli(['--dry-run'], runner, writeOut, writeError), 0);
    assert.include(stdout.pop(), 'install_days: 3');
    assert.equal(runCli([], runner, writeOut, writeError), 1);
    assert.include(stderr.pop(), 'Refusing to reset analytics');
  });

  it('runs the reset help entry point without requiring Wrangler configuration', () => {
    const result = spawnSync(process.execPath, ['analytics-worker/reset.ts', '--help'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Usage: node analytics-worker/reset.ts');
    assert.equal(result.stderr, '');
  });

  it('returns a failing status and actionable stderr from the reset entry point', () => {
    const result = spawnSync(process.execPath, ['analytics-worker/reset.ts', '--unknown'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'analytics reset: Unknown analytics reset option: --unknown\n');
  });
});
