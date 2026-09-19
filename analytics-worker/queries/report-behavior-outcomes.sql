SELECT
  event,
  sum(count) AS total,
  sum(CASE WHEN status = 'success' THEN count ELSE 0 END) AS successes,
  sum(CASE WHEN status = 'failure' THEN count ELSE 0 END) AS failures,
  1.0 * sum(CASE WHEN status = 'failure' THEN count ELSE 0 END)
    / nullif(sum(count), 0) AS failure_rate
FROM behavior_events_daily
WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
GROUP BY event
ORDER BY event;
