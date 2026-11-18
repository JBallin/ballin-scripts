-- Categories and totals describe backup.run in the same read snapshot.
WITH categories AS (
  SELECT category, sum(count) AS failures
  FROM backup_failures_daily
  WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
  GROUP BY category
), totals AS (
  SELECT coalesce(sum(count), 0) AS total_failures
  FROM behavior_events_daily
  WHERE event = 'backup.run' AND status = 'failure'
    AND date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
)
SELECT category, coalesce(failures, 0) AS failures, total_failures
FROM totals LEFT JOIN categories ON true
ORDER BY category;
