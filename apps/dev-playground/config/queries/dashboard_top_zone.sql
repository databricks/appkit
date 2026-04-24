-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
-- @param fareMin STRING
-- @param fareMax STRING
SELECT pickup_zip, COUNT(*) as trip_count
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
  AND (COALESCE(:fareMin, 'all') = 'all' OR fare_amount >= CAST(:fareMin AS DOUBLE))
  AND (COALESCE(:fareMax, 'all') = 'all' OR fare_amount <= CAST(:fareMax AS DOUBLE))
GROUP BY pickup_zip
ORDER BY trip_count DESC
LIMIT 1
