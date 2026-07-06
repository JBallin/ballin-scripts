const { assert } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  dateRangeFromArgs,
  defaultDatabase,
  generateReport,
  loadReportQueries,
  optionsFromArgs,
  parseD1Json,
  renderReport,
  runWrangler,
  wranglerArgsFor,
} = require('../analytics-worker/report.ts');

type D1Row = Record<string, unknown>;
type SpawnCall = {
  args: string[];
  command: string;
};

describe('analytics D1 report', () => {
  it('defaults to the last 30 UTC days ending today', () => {
    const range = dateRangeFromArgs({
      database: defaultDatabase,
      help: false,
    }, new Date('2026-06-30T23:59:00.000Z'));

    assert.deepEqual(range, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('validates date arguments before building queries', () => {
    assert.throws(() => dateRangeFromArgs({
      database: defaultDatabase,
      from: '2026-02-30',
      help: false,
      to: '2026-03-01',
    }), '--from must be a valid YYYY-MM-DD date');

    assert.throws(() => dateRangeFromArgs({
      database: defaultDatabase,
      from: '2026-06-30',
      help: false,
      to: '2026-06-01',
    }), '--from must be on or before --to');
  });

  it('loads only read-only aggregate queries with validated date buckets', () => {
    const queries = loadReportQueries({
      database: defaultDatabase,
      from: '2026-06-01',
      to: '2026-06-30',
    });
    const allSql = Object.values(queries).join('\n');

    assert.include(allSql, "FROM install_days");
    assert.include(allSql, "FROM command_events_daily");
    assert.include(allSql, "FROM version_events_daily");
    assert.notInclude(allSql, '__FROM_DATE__');
    assert.notInclude(allSql, '__TO_DATE__');
    assert.notMatch(allSql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
  });

  it('renders active installs, command status, and runtime trends', () => {
    const output = renderReport({
      activeInstalls: [
        { date_bucket: '2026-06-01', active_installs: 2 },
        { date_bucket: '2026-06-03', active_installs: 1 },
      ],
      commandStatus: [
        {
          command: 'ballin update',
          total: 5,
          successes: 3,
          failures: 1,
          unknown: 1,
        },
      ],
      runtimeTrends: [
        {
          date_bucket: '2026-06-01',
          app_version: '1.0.0',
          node_major: '24',
          os: 'darwin',
          os_version: '15',
          events: 5,
        },
      ],
    }, {
      database: defaultDatabase,
      from: '2026-06-01',
      to: '2026-06-03',
    });

    assert.include(output, 'Analytics report (2026-06-01 to 2026-06-03)');
    assert.include(output, 'Caveat: analytics are public client telemetry; aggregate counts are directional and not security-trustworthy.');
    assert.include(output, '2026-06-02  0');
    assert.include(output, 'ballin update  5      3        1        1        20.0%');
    assert.include(output, '2026-06-01  1.0.0        24          darwin  15          5');
  });

  it('prints clear empty states for sparse aggregate data', () => {
    const output = renderReport({
      activeInstalls: [],
      commandStatus: [],
      runtimeTrends: [],
    }, {
      database: defaultDatabase,
      from: '2026-06-01',
      to: '2026-06-01',
    });

    assert.include(output, '2026-06-01  0');
    assert.include(output, 'No command events found for this range.');
    assert.include(output, 'No runtime/version events found for this range.');
  });

  it('generates the report with an injected D1 runner', () => {
    const sqlStatements: string[] = [];
    const report = generateReport({
      database: defaultDatabase,
      from: '2026-06-01',
      to: '2026-06-01',
    }, (sql: string): D1Row[] => {
      sqlStatements.push(sql);
      if (sql.includes('install_days')) {
        return [{ date_bucket: '2026-06-01', active_installs: 4 }];
      }
      if (sql.includes('command_events_daily')) {
        return [{
          command: 'ballin backup',
          failures: 0,
          successes: 2,
          total: 2,
          unknown: 0,
        }];
      }
      return [{
        app_version: '1.0.0',
        date_bucket: '2026-06-01',
        events: 2,
        node_major: '24',
        os: 'darwin',
        os_version: '15',
      }];
    });

    assert.lengthOf(sqlStatements, 3);
    assert.include(report, '2026-06-01  4');
    assert.include(report, 'ballin backup  2      2        0        0        0.0%');
  });

  it('parses Wrangler D1 JSON result rows', () => {
    const rows = parseD1Json(JSON.stringify([
      {
        results: [
          { command: 'ballin update', total: 3 },
        ],
        success: true,
      },
    ]));

    assert.deepEqual(rows, [{ command: 'ballin update', total: 3 }]);
  });

  it('rejects unsuccessful Wrangler D1 JSON responses', () => {
    assert.throws(() => {
      parseD1Json(JSON.stringify([{ success: false }]));
    }, 'Wrangler D1 query failed');
  });

  it('builds remote JSON Wrangler D1 execute arguments', () => {
    const args = wranglerArgsFor('SELECT 1', {
      database: 'example-db',
      from: '2026-06-01',
      rootDir: '/repo',
      to: '2026-06-30',
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

  it('surfaces Wrangler failures without running real commands in tests', () => {
    const calls: SpawnCall[] = [];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-report-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');

    assert.throws(() => {
      runWrangler('SELECT 1', {
        database: defaultDatabase,
        from: '2026-06-01',
        rootDir,
        to: '2026-06-30',
      }, (command: string, args: string[]) => {
        calls.push({ args, command });
        return {
          error: undefined,
          output: [],
          pid: 1,
          signal: null,
          status: 1,
          stderr: 'D1 unavailable',
          stdout: '',
        };
      });
    }, 'D1 unavailable');

    assert.deepEqual(calls.map((call) => call.command), ['wrangler']);
    assert.include(calls[0].args, '--remote');
  });

  it('explains the required local Wrangler config before running commands', () => {
    const calls: SpawnCall[] = [];

    assert.throws(() => {
      runWrangler('SELECT 1', {
        database: defaultDatabase,
        from: '2026-06-01',
        rootDir: '/repo',
        to: '2026-06-30',
      }, (command: string, args: string[]) => {
        calls.push({ args, command });
        return {
          error: undefined,
          output: [],
          pid: 1,
          signal: null,
          status: 0,
          stderr: '',
          stdout: '[]',
        };
      });
    }, 'Missing analytics Worker config: /repo/analytics-worker/wrangler.toml');

    assert.deepEqual(calls, []);
  });

  it('parses CLI options for custom date ranges and databases', () => {
    const options = optionsFromArgs([
      '--from',
      '2026-06-01',
      '--to',
      '2026-06-30',
      '--database',
      'custom-db',
    ]);

    assert.deepEqual(options, {
      database: 'custom-db',
      from: '2026-06-01',
      help: false,
      to: '2026-06-30',
    });
  });

  it('rejects missing CLI option values', () => {
    assert.throws(() => optionsFromArgs(['--from']), '--from requires a value');
    assert.throws(() => optionsFromArgs(['--to', '--database', 'custom-db']), '--to requires a value');
    assert.throws(() => optionsFromArgs(['--database']), '--database requires a value');
  });
});
