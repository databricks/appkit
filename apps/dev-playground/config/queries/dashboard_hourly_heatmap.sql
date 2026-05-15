-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
-- @param fareMin STRING
-- @param fareMax STRING
--
-- Aggregates trips by (day-of-week, hour-of-day) for the heatmap chart.
-- `day_of_week` is 1=Sunday … 7=Saturday (Spark's default), which the
-- client maps back to a human label. Hour is 0–23 in the trip's local
-- timezone (the dataset is NYC-local already).
SELECT
  DAYOFWEEK(tpep_pickup_datetime) AS day_of_week,
  HOUR(tpep_pickup_datetime) AS hour_of_day,
  COUNT(*) AS trip_count,
  ROUND(AVG(fare_amount), 2) AS avg_fare
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
  AND (COALESCE(:fareMin, 'all') = 'all' OR fare_amount >= CAST(:fareMin AS DOUBLE))
  AND (COALESCE(:fareMax, 'all') = 'all' OR fare_amount <= CAST(:fareMax AS DOUBLE))
GROUP BY day_of_week, hour_of_day
ORDER BY day_of_week, hour_of_day
