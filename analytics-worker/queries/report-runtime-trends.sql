SELECT
  date_bucket,
  app_version,
  node_major,
  os,
  os_version,
  sum(count) AS events
FROM version_events_daily
WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
GROUP BY date_bucket, app_version, node_major, os, os_version
ORDER BY date_bucket, events DESC, app_version, node_major, os, os_version;
