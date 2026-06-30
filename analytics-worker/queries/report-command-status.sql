SELECT
  command,
  sum(count) AS total,
  sum(CASE WHEN status = 'success' THEN count ELSE 0 END) AS successes,
  sum(CASE WHEN status = 'failure' THEN count ELSE 0 END) AS failures,
  sum(CASE WHEN status = 'unknown' THEN count ELSE 0 END) AS unknown
FROM command_events_daily
WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
GROUP BY command
ORDER BY total DESC, command;
