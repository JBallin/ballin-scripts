CREATE TABLE IF NOT EXISTS behavior_events_daily (
  date_bucket TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('backup.run', 'update.backup', 'update.self-update')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date_bucket, event, status)
);
