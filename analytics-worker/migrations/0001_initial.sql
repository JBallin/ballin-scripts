CREATE TABLE IF NOT EXISTS install_days (
  date_bucket TEXT NOT NULL,
  install_id_hash TEXT NOT NULL,
  PRIMARY KEY (date_bucket, install_id_hash)
);

CREATE TABLE IF NOT EXISTS command_events_daily (
  date_bucket TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date_bucket, command, status, duration_bucket)
);

CREATE TABLE IF NOT EXISTS version_events_daily (
  date_bucket TEXT NOT NULL,
  command TEXT NOT NULL,
  app_version TEXT NOT NULL,
  node_major TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (
    date_bucket,
    command,
    app_version,
    node_major,
    os,
    os_version
  )
);

CREATE INDEX IF NOT EXISTS install_days_install_id_hash_idx
  ON install_days (install_id_hash);

CREATE INDEX IF NOT EXISTS command_events_daily_date_command_idx
  ON command_events_daily (date_bucket, command);

CREATE INDEX IF NOT EXISTS version_events_daily_date_command_idx
  ON version_events_daily (date_bucket, command);
