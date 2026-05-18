-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
-- @param fareMin STRING
-- @param fareMax STRING
SELECT
  COUNT(*) as total_trips,
  ROUND(AVG(fare_amount), 2) as avg_fare,
  ROUND(AVG(trip_distance), 2) as avg_distance,
  ROUND(MAX(fare_amount), 2) as max_fare,
  ROUND(MIN(fare_amount), 2) as min_fare
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
  AND (COALESCE(:fareMin, 'all') = 'all' OR fare_amount >= CAST(:fareMin AS DOUBLE))
  AND (COALESCE(:fareMax, 'all') = 'all' OR fare_amount <= CAST(:fareMax AS DOUBLE))
