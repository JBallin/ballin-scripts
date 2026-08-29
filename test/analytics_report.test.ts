const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  dateRangeFromArgs,
  defaultDatabase,
  generateReport,
  loadReportQueries,
  optionsFromArgs,
  parseD1Json,
  renderReport,
  runCli,
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
    assert.throws(() => dateRangeFromArgs({
      database: defaultDatabase,
      from: '2026-06-01',
      help: false,
      to: 'June 30',
    }), '--to must be a valid YYYY-MM-DD date');
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

  it('normalizes malformed aggregate values without misreporting failures', () => {
    const output = renderReport({
      activeInstalls: [{ date_bucket: null, active_installs: 'not-a-number' }],
      commandStatus: [{ command: '', total: 0, failures: Infinity }],
      runtimeTrends: [{ events: '2' }],
    }, {
      database: defaultDatabase,
      from: '2026-06-01',
      to: '2026-06-01',
    });

    assert.include(output, '2026-06-01  0');
    assert.match(output, /unknown\s+0\s+0\s+0\s+0\s+0\.0%/);
    assert.include(output, 'unknown  unknown      unknown     unknown  unknown     2');
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

  it('normalizes supported Wrangler JSON envelopes and ignores malformed rows', () => {
    assert.deepEqual(parseD1Json(JSON.stringify([
      { total: 1 },
      null,
      'bad row',
    ])), [{ total: 1 }]);
    assert.deepEqual(parseD1Json(JSON.stringify({
      result: [{ results: [{ total: 2 }], success: true }],
    })), [{ total: 2 }]);
    assert.deepEqual(parseD1Json('null'), []);
    assert.deepEqual(parseD1Json('{}'), []);
    assert.throws(() => parseD1Json('{'), 'Wrangler returned invalid JSON');
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

  it('surfaces spawn errors and stdout/default Wrangler failure messages', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-report-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');
    const options = { database: defaultDatabase, from: '2026-06-01', rootDir, to: '2026-06-30' };
    const result = (overrides: Record<string, unknown>) => ({
      error: undefined,
      output: [],
      pid: 1,
      signal: null,
      status: 0,
      stderr: '',
      stdout: '[]',
      ...overrides,
    });

    assert.throws(() => runWrangler('SELECT 1', options, () => result({
      error: new Error('spawn denied'),
    })), 'spawn denied');
    assert.throws(() => runWrangler('SELECT 1', options, () => result({
      status: 1,
      stdout: 'structured failure',
    })), 'structured failure');
    assert.throws(() => runWrangler('SELECT 1', options, () => result({
      status: null,
      stdout: '',
    })), 'Wrangler D1 query failed');
  });

  it('falls back to npx --yes wrangler when wrangler is unavailable', () => {
    const calls: SpawnCall[] = [];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-report-'));
    fs.mkdirSync(path.join(rootDir, 'analytics-worker'));
    fs.writeFileSync(path.join(rootDir, 'analytics-worker', 'wrangler.toml'), '');
    const options = {
      database: defaultDatabase,
      from: '2026-06-01',
      rootDir,
      to: '2026-06-30',
    };
    const wranglerArgs = wranglerArgsFor('SELECT 1', options);

    const rows = runWrangler('SELECT 1', options, (command: string, args: string[]) => {
      calls.push({ args, command });
      if (command === 'wrangler') {
        return {
          error: Object.assign(new Error('missing wrangler'), { code: 'ENOENT' }),
          output: [],
          pid: 1,
          signal: null,
          status: null,
          stderr: '',
          stdout: '',
        };
      }
      return {
        error: undefined,
        output: [],
        pid: 1,
        signal: null,
        status: 0,
        stderr: '',
        stdout: JSON.stringify([{ results: [{ total: 1 }], success: true }]),
      };
    });

    assert.deepEqual(calls, [
      { args: wranglerArgs, command: 'wrangler' },
      { args: ['--yes', 'wrangler', ...wranglerArgs], command: 'npx' },
    ]);
    assert.deepEqual(rows, [{ total: 1 }]);
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

  it('handles report CLI help, success, and validation failures through injected boundaries', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writeOut = (text: string) => stdout.push(text);
    const writeError = (text: string) => stderr.push(text);
    const runner = (sql: string): D1Row[] => (
      sql.includes('install_days') ? [{ date_bucket: '2026-06-01', active_installs: 1 }] : []
    );

    assert.equal(runCli(['--help'], runner, writeOut, writeError), 0);
    assert.include(stdout.pop(), 'Usage: npm run analytics:report');
    assert.equal(runCli(['--from', '2026-06-01', '--to', '2026-06-01'], runner, writeOut, writeError), 0);
    assert.include(stdout.pop(), '2026-06-01  1');
    assert.equal(runCli(['--unknown'], runner, writeOut, writeError), 1);
    assert.equal(stderr.pop(), 'analytics report: Unknown analytics report option: --unknown\n');
  });

  it('runs the report help entry point without requiring Wrangler configuration', () => {
    const result = spawnSync(process.execPath, ['analytics-worker/report.ts', '--help'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Usage: npm run analytics:report');
    assert.equal(result.stderr, '');
  });

  it('returns a failing status and actionable stderr from the report entry point', () => {
    const result = spawnSync(process.execPath, ['analytics-worker/report.ts', '--unknown'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'analytics report: Unknown analytics report option: --unknown\n');
  });

  it('rejects missing CLI option values', () => {
    assert.throws(() => optionsFromArgs(['--from']), '--from requires a value');
    assert.throws(() => optionsFromArgs(['--to', '--database', 'custom-db']), '--to requires a value');
    assert.throws(() => optionsFromArgs(['--database']), '--database requires a value');
    assert.deepEqual(optionsFromArgs(['-h']), {
      database: defaultDatabase,
      from: '',
      help: true,
      to: '',
    });
  });
});
