-- Daily active installs for one date.
SELECT count(*) AS dau
FROM install_days
WHERE date_bucket = ?1;

-- Weekly active installs over an inclusive date range.
SELECT count(DISTINCT install_id_hash) AS wau
FROM install_days
WHERE date_bucket BETWEEN ?1 AND ?2;

-- Monthly active installs over an inclusive date range.
SELECT count(DISTINCT install_id_hash) AS mau
FROM install_days
WHERE date_bucket BETWEEN ?1 AND ?2;

-- Daily active installs by day.
SELECT date_bucket, count(*) AS active_installs
FROM install_days
WHERE date_bucket BETWEEN ?1 AND ?2
GROUP BY date_bucket
ORDER BY date_bucket;
