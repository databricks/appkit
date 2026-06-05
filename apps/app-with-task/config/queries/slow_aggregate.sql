-- CPU-heavy aggregate over 300M synthetic rows.
-- Row-by-row MD5 keeps the query long enough for the crash-recovery
-- demo, while bounded per-bucket aggregates avoid shuffle-memory spikes
-- on Small SQL warehouses. `current_timestamp()` keeps the result cache
-- out of the path.
WITH src AS (
    SELECT
        id,
        SUBSTR(MD5(CAST(id AS STRING)), 1, 2) AS bucket,
        CAST(id % 1000000 AS BIGINT) AS metric
    FROM RANGE(300000000)
)
SELECT
    bucket,
    COUNT(*) AS total_rows,
    SUM(metric) AS metric_sum,
    AVG(metric) AS metric_avg,
    APPROX_COUNT_DISTINCT(metric) AS approx_unique_metric,
    current_timestamp() AS cache_buster
FROM src
GROUP BY bucket
ORDER BY total_rows DESC
LIMIT 100;
