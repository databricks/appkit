-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
SELECT
  DATE(tpep_pickup_datetime) as trip_date,
  COUNT(*) as trip_count,
  ROUND(AVG(fare_amount), 2) as avg_fare,
  ROUND(SUM(fare_amount), 2) as total_revenue
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
GROUP BY DATE(tpep_pickup_datetime)
ORDER BY trip_date
LIMIT 60
