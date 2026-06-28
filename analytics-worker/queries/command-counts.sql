-- Command counts by day and command.
SELECT date_bucket, command, sum(count) AS events
FROM command_events_daily
WHERE date_bucket BETWEEN ?1 AND ?2
GROUP BY date_bucket, command
ORDER BY date_bucket, command;

-- Failure counts by day and command.
SELECT date_bucket, command, sum(count) AS failures
FROM command_events_daily
WHERE date_bucket BETWEEN ?1 AND ?2
  AND status = 'failure'
GROUP BY date_bucket, command
ORDER BY date_bucket, command;

-- Failure rate by command over an inclusive date range.
SELECT
  command,
  sum(CASE WHEN status = 'failure' THEN count ELSE 0 END) AS failures,
  sum(count) AS total,
  1.0 * sum(CASE WHEN status = 'failure' THEN count ELSE 0 END) / sum(count) AS failure_rate
FROM command_events_daily
WHERE date_bucket BETWEEN ?1 AND ?2
GROUP BY command
ORDER BY failure_rate DESC, total DESC;
