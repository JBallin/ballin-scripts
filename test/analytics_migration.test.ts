const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const migrationsDir = path.join(__dirname, '..', 'analytics-worker', 'migrations');
const migrationSql = (filename: string): string => (
  fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
);

describe('analytics D1 migrations', () => {
  it('adds only constrained behavioral aggregates and preserves all existing rows', () => {
    const database = new DatabaseSync(':memory:');

    try {
      database.exec(migrationSql('0001_initial.sql'));
      database.exec(migrationSql('0002_remove_os_family.sql'));
      database.exec(`
        INSERT INTO install_days (date_bucket, install_id_hash)
        VALUES ('2026-09-11', 'existing-hash');
        INSERT INTO command_events_daily (date_bucket, command, status, duration_bucket, count)
        VALUES ('2026-09-11', 'ballin backup', 'success', '<1s', 2);
        INSERT INTO version_events_daily (date_bucket, command, app_version, node_major, os_version, count)
        VALUES ('2026-09-11', 'ballin backup', '2.0.0', '24', '26.6', 3);
      `);
      const existingTables = ['install_days', 'command_events_daily', 'version_events_daily'];
      const before = existingTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());

      database.exec(migrationSql('0003_behavior_events_daily.sql'));

      assert.deepEqual(
        existingTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
        before,
      );
      assert.deepEqual(database.prepare('SELECT * FROM behavior_events_daily').all(), []);
      const columns = database.prepare('PRAGMA table_info(behavior_events_daily)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      assert.deepEqual(columns.map(({ name }) => name), ['date_bucket', 'event', 'status', 'count']);
      assert.isTrue(columns.every(({ notnull }) => notnull === 1));
      assert.deepEqual(
        columns.filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk).map(({ name }) => name),
        ['date_bucket', 'event', 'status'],
      );

      const insert = database.prepare(`
        INSERT INTO behavior_events_daily (date_bucket, event, status, count)
        VALUES (?, ?, ?, 1)
      `);
      for (const event of ['backup.run', 'update.backup', 'update.self-update']) {
        for (const status of ['success', 'failure']) {
          insert.run('2026-09-11', event, status);
        }
      }
      assert.throws(() => insert.run('2026-09-11', 'backup.run', 'success'), /UNIQUE constraint failed/u);
      for (const event of ['backup', 'update.doctor', 'backup.read', '']) {
        assert.throws(() => insert.run('2026-09-11', event, 'success'), /CHECK constraint failed/u);
      }
      for (const status of ['attempted', 'skipped', 'unknown', '']) {
        assert.throws(() => insert.run('2026-09-11', 'backup.run', status), /CHECK constraint failed/u);
      }
      assert.throws(() => insert.run('2026-09-11', null, 'success'), /NOT NULL constraint failed/u);
      assert.throws(() => insert.run('2026-09-11', 'backup.run', null), /NOT NULL constraint failed/u);
      database.exec(`
        INSERT INTO behavior_events_daily (date_bucket, event, status, count)
        VALUES ('2026-09-11', 'backup.run', 'success', 1)
        ON CONFLICT(date_bucket, event, status) DO UPDATE SET count = count + 1
      `);
      assert.deepEqual(database.prepare(`
        SELECT count FROM behavior_events_daily
        WHERE date_bucket = '2026-09-11' AND event = 'backup.run' AND status = 'success'
      `).get(), { count: 2 });
      assert.deepEqual(database.prepare('SELECT count(*) AS rows FROM behavior_events_daily').get(), { rows: 6 });
      assert.deepEqual(
        existingTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
        before,
      );
    } finally {
      database.close();
    }
  });

  it('recreates version aggregates without OS family or historical rows', () => {
    const database = new DatabaseSync(':memory:');

    try {
      database.exec(migrationSql('0001_initial.sql'));
      database.exec(`
        INSERT INTO install_days (date_bucket, install_id_hash)
        VALUES ('2026-09-11', 'hash');
        INSERT INTO command_events_daily (
          date_bucket,
          command,
          status,
          duration_bucket,
          count
        ) VALUES ('2026-09-11', 'ballin', 'success', '<1s', 2);
        INSERT INTO version_events_daily (
          date_bucket,
          command,
          app_version,
          node_major,
          os,
          os_version,
          count
        ) VALUES ('2026-09-11', 'ballin', '2.0.0', '24', 'darwin', '26.6', 3);
      `);

      database.exec(migrationSql('0002_remove_os_family.sql'));

      const columns = database.prepare('PRAGMA table_info(version_events_daily)').all() as Array<{
        name: string;
        pk: number;
      }>;
      assert.deepEqual(columns.map(({ name }) => name), [
        'date_bucket',
        'command',
        'app_version',
        'node_major',
        'os_version',
        'count',
      ]);
      assert.deepEqual(
        columns.filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk).map(({ name }) => name),
        ['date_bucket', 'command', 'app_version', 'node_major', 'os_version'],
      );
      assert.deepEqual(
        database.prepare('SELECT count(*) AS rows FROM version_events_daily').get(),
        { rows: 0 },
      );
      assert.deepEqual(database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'version_events_daily_date_command_idx'
      `).get(), { name: 'version_events_daily_date_command_idx' });
      assert.deepEqual(database.prepare('SELECT count(*) AS rows FROM install_days').get(), { rows: 1 });
      assert.deepEqual(database.prepare('SELECT count(*) AS rows FROM command_events_daily').get(), { rows: 1 });

      const incrementVersion = `
        INSERT INTO version_events_daily (
          date_bucket,
          command,
          app_version,
          node_major,
          os_version,
          count
        ) VALUES ('2026-09-11', 'ballin', '2.0.0', '24', '26.6', 1)
        ON CONFLICT(date_bucket, command, app_version, node_major, os_version)
        DO UPDATE SET count = count + 1
      `;
      database.exec(incrementVersion);
      database.exec(incrementVersion);
      assert.deepEqual(
        database.prepare('SELECT os_version, count FROM version_events_daily').get(),
        { os_version: '26.6', count: 2 },
      );
    } finally {
      database.close();
    }
  });
});
