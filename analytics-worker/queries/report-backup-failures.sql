-- Categories and legacy failures describe backup.run only.
WITH categories AS (
  SELECT category, sum(count) AS failures
  FROM backup_failures_daily
  WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
  GROUP BY category
), totals AS (
  SELECT coalesce(sum(count), 0) AS failures
  FROM behavior_events_daily
  WHERE event = 'backup.run' AND status = 'failure'
    AND date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
)
SELECT category, failures FROM categories
UNION ALL
SELECT 'legacy_uncategorized', totals.failures - coalesce((SELECT sum(failures) FROM categories), 0)
FROM totals WHERE totals.failures > 0
ORDER BY category;
