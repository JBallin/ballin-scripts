const { assert } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  aggregateTables,
  confirmationPhrase,
  countSql,
  defaultDatabase,
  parseArgs,
  resetAnalytics,
  resetSql,
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

  it('falls back to npx wrangler when wrangler is unavailable', () => {
    const calls: SpawnCall[] = [];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-reset-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');

    const rows = runWrangler('SELECT 1', {
      database: defaultDatabase,
      dryRun: true,
      help: false,
      rootDir,
    }, (command: string, args: string[]) => {
      calls.push({ args, command });
      if (command === 'wrangler') {
        return {
          ...d1Success(),
          error: Object.assign(new Error('missing wrangler'), { code: 'ENOENT' }),
        };
      }
      return d1Success([{ rows: 1, table_name: 'install_days' }]);
    });

    assert.deepEqual(calls.map((call) => call.command), ['wrangler', 'npx']);
    assert.deepEqual(rows, [{ rows: 1, table_name: 'install_days' }]);
  });
});
