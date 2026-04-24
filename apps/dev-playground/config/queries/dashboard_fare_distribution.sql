-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
SELECT
  CASE
    WHEN fare_amount < 5 THEN '$0-5'
    WHEN fare_amount < 10 THEN '$5-10'
    WHEN fare_amount < 15 THEN '$10-15'
    WHEN fare_amount < 20 THEN '$15-20'
    WHEN fare_amount < 30 THEN '$20-30'
    WHEN fare_amount < 50 THEN '$30-50'
    ELSE '$50+'
  END as fare_bucket,
  COUNT(*) as trip_count,
  ROUND(AVG(trip_distance), 2) as avg_distance
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
GROUP BY fare_bucket
ORDER BY MIN(fare_amount)
