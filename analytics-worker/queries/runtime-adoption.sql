-- Runtime/version adoption by day.
SELECT
  date_bucket,
  command,
  app_version,
  node_major,
  os,
  os_version,
  sum(count) AS events
FROM version_events_daily
WHERE date_bucket BETWEEN ?1 AND ?2
GROUP BY date_bucket, command, app_version, node_major, os, os_version
ORDER BY date_bucket, command, events DESC;
