-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
-- @param fareMin STRING
-- @param fareMax STRING
--
-- Daily rollup feeding the sparklines embedded in the KPI cards. Same
-- filter shape as every other dashboard query so the whole surface moves
-- in lockstep when the user narrows the view. The default unfiltered
-- range covers all of 2016, which is bounded enough to render inline.
SELECT
  DATE(tpep_pickup_datetime) AS trip_date,
  COUNT(*) AS trip_count,
  ROUND(SUM(fare_amount), 2) AS total_revenue,
  ROUND(AVG(fare_amount), 2) AS avg_fare,
  ROUND(AVG(trip_distance), 2) AS avg_distance
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
  AND (COALESCE(:fareMin, 'all') = 'all' OR fare_amount >= CAST(:fareMin AS DOUBLE))
  AND (COALESCE(:fareMax, 'all') = 'all' OR fare_amount <= CAST(:fareMax AS DOUBLE))
GROUP BY DATE(tpep_pickup_datetime)
ORDER BY trip_date
