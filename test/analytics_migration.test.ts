const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const migrationsDir = path.join(__dirname, '..', 'analytics-worker', 'migrations');
const migrationSql = (filename: string): string => (
  fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
);

describe('analytics D1 migrations', () => {
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
