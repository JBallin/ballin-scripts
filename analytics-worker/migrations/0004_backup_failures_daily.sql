-- Additive: historical v2 failures remain in behavior_events_daily, without backfill.
CREATE TABLE backup_failures_daily (
  date_bucket TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('transport', 'authentication', 'reconciliation', 'local_state', 'unknown')),
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY(date_bucket, category)
);
