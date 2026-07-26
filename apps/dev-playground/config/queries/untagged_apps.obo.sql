-- OBO query (.obo.sql) — executes as the logged-in user, not the service principal.
-- @param aggregationLevel STRING
-- @param startDate DATE
-- @param endDate DATE
-- NOTE: 2016-only data; :startDate/:endDate are no-op guards (see spend_data).
-- Pickup ZIP stands in for "app", dropoff ZIP for "creator" (demo data).
WITH periods AS (
  SELECT CAST(pickup_zip AS STRING) AS app_name, CAST(dropoff_zip AS STRING) AS creator,
    date_trunc(COALESCE(:aggregationLevel,'day'), tpep_pickup_datetime) AS period,
    SUM(fare_amount) AS period_cost_usd
  FROM samples.nyctaxi.trips
  WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2017-01-01'
    AND (COALESCE(CAST(:startDate AS DATE), DATE'2016-01-01') IS NOT NULL)
    AND (COALESCE(CAST(:endDate   AS DATE), DATE'2016-12-31') IS NOT NULL)
    AND pickup_zip IS NOT NULL
  GROUP BY pickup_zip, dropoff_zip, date_trunc(COALESCE(:aggregationLevel,'day'), tpep_pickup_datetime))
SELECT app_name, creator, ROUND(SUM(period_cost_usd),2) AS total_cost_usd,
  ROUND(AVG(period_cost_usd),2) AS avg_period_cost_usd
FROM periods GROUP BY app_name, creator ORDER BY total_cost_usd DESC LIMIT 100
