-- NOTE: samples.nyctaxi.trips is 2016-only; data window pinned to 2016.
-- Pickup ZIP stands in for "app"; dropoff ZIP for "creator" (demo data).
SELECT CAST(pickup_zip AS STRING) AS id, CAST(pickup_zip AS STRING) AS name,
  CAST(dropoff_zip AS STRING) AS creator, '[]' AS tags,
  ROUND(SUM(fare_amount)) AS totalSpend, MIN(tpep_pickup_datetime) AS createdAt
FROM samples.nyctaxi.trips
WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2017-01-01'
  AND pickup_zip IS NOT NULL
GROUP BY pickup_zip, dropoff_zip ORDER BY totalSpend DESC LIMIT 10
