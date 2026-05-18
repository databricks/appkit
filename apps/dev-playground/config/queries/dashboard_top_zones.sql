-- @param dateFrom STRING
-- @param dateTo STRING
-- @param pickupZip STRING
-- @param fareMin STRING
-- @param fareMax STRING
--
-- Top 10 pickup zips ranked by trip count. Returns revenue + avg fare
-- alongside so the horizontal-bar chart can toggle metrics without a
-- round trip. `dashboard_top_zone.sql` (LIMIT 1) is kept for the KPI
-- card; this one drives the leaderboard chart.
--
-- Note: `pickup_zip` in samples.nyctaxi.trips is an INT column, so any
-- `pickup_zip != ''` guard silently filters out every row (Spark casts
-- '' → NULL → `pickup_zip != NULL` is UNKNOWN → treated as false).
-- The singular zone query proves no null-guard is needed here.
SELECT
  -- Cast to STRING so the client, the agent's `highlight_zone` tool, and
  -- the `filter_by_pickup_zip` parameter all speak the same type (the ZIP
  -- is semantically an identifier, not a number). Without this, Map.has()
  -- lookups in TopZonesChart silently miss when the agent tries to ring
  -- a specific ZIP.
  CAST(pickup_zip AS STRING) AS pickup_zip,
  COUNT(*) AS trip_count,
  ROUND(SUM(fare_amount), 2) AS total_revenue,
  ROUND(AVG(fare_amount), 2) AS avg_fare
FROM samples.nyctaxi.trips
WHERE 1 = 1
  AND (COALESCE(:dateFrom, 'all') = 'all' OR tpep_pickup_datetime >= :dateFrom)
  AND (COALESCE(:dateTo, 'all') = 'all' OR tpep_pickup_datetime <= :dateTo)
  AND (COALESCE(:pickupZip, 'all') = 'all' OR pickup_zip IN (SELECT TRIM(value) FROM (VALUES (:pickupZip)) AS t(value)))
  AND (COALESCE(:fareMin, 'all') = 'all' OR fare_amount >= CAST(:fareMin AS DOUBLE))
  AND (COALESCE(:fareMax, 'all') = 'all' OR fare_amount <= CAST(:fareMax AS DOUBLE))
GROUP BY pickup_zip
ORDER BY trip_count DESC
LIMIT 10
