SELECT date_bucket, count(*) AS active_installs
FROM install_days
WHERE date_bucket BETWEEN '__FROM_DATE__' AND '__TO_DATE__'
GROUP BY date_bucket
ORDER BY date_bucket;
