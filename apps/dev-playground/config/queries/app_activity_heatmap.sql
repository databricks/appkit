-- Activity heatmap: spend by pickup ZIP (rows) and day of week (columns).
-- @param startDate DATE
-- @param endDate DATE
-- NOTE: 2016-only data; :startDate/:endDate are no-op guards (see spend_data).
WITH top_zones AS (
  SELECT pickup_zip FROM samples.nyctaxi.trips
  WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2017-01-01'
    AND pickup_zip IS NOT NULL
  GROUP BY pickup_zip ORDER BY COUNT(*) DESC LIMIT 8)
SELECT CAST(t.pickup_zip AS STRING) AS app_name,
  date_format(t.tpep_pickup_datetime,'EEEE') AS day_of_week,
  ROUND(SUM(t.fare_amount),2) AS spend
FROM samples.nyctaxi.trips t JOIN top_zones z ON t.pickup_zip=z.pickup_zip
WHERE t.tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND t.tpep_pickup_datetime < TIMESTAMP'2017-01-01'
  AND (COALESCE(CAST(:startDate AS DATE), DATE'2016-01-01') IS NOT NULL)
  AND (COALESCE(CAST(:endDate   AS DATE), DATE'2016-12-31') IS NOT NULL)
GROUP BY t.pickup_zip, date_format(t.tpep_pickup_datetime,'EEEE')
ORDER BY app_name, day_of_week
