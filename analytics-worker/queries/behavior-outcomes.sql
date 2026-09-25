-- Observed terminal outcomes by UTC day and event over an inclusive date range.
-- Events overlap and cannot be matched, summed or subtracted to infer backup
-- volume, direct-backup volume, or exact coverage of update executions.
SELECT
  date_bucket,
  event,
  sum(count) AS total,
  sum(CASE WHEN status = 'success' THEN count ELSE 0 END) AS successes,
  sum(CASE WHEN status = 'failure' THEN count ELSE 0 END) AS failures,
  1.0 * sum(CASE WHEN status = 'failure' THEN count ELSE 0 END)
    / nullif(sum(count), 0) AS failure_rate
FROM behavior_events_daily
WHERE date_bucket BETWEEN ?1 AND ?2
GROUP BY date_bucket, event
ORDER BY date_bucket, event;
