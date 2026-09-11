DROP TABLE IF EXISTS version_events_daily;

CREATE TABLE version_events_daily (
  date_bucket TEXT NOT NULL,
  command TEXT NOT NULL,
  app_version TEXT NOT NULL,
  node_major TEXT NOT NULL,
  os_version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (
    date_bucket,
    command,
    app_version,
    node_major,
    os_version
  )
);

CREATE INDEX version_events_daily_date_command_idx
  ON version_events_daily (date_bucket, command);
