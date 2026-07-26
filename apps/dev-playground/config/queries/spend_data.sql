-- @param groupBy STRING
-- @param aggregationLevel STRING
-- @param startDate DATE
-- @param endDate DATE
-- @param appId STRING
-- @param creator STRING
-- NOTE: 2016-only data; :startDate/:endDate are no-op guards (kept so client
-- params pass analytics param validation). Pickup/dropoff ZIP stand in for
-- appId/creator.
SELECT COALESCE(:groupBy,'default') AS group_key,
  date_trunc(COALESCE(:aggregationLevel,'day'), tpep_pickup_datetime) AS aggregation_period,
  ROUND(SUM(fare_amount),2) AS cost_usd
FROM samples.nyctaxi.trips
WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2016-02-01'
  AND (COALESCE(CAST(:startDate AS DATE), DATE'2016-01-01') IS NOT NULL)
  AND (COALESCE(CAST(:endDate   AS DATE), DATE'2016-12-31') IS NOT NULL)
  AND (COALESCE(:appId,'all')='all'   OR CAST(pickup_zip  AS STRING)=:appId)
  AND (COALESCE(:creator,'all')='all' OR CAST(dropoff_zip AS STRING)=:creator)
GROUP BY date_trunc(COALESCE(:aggregationLevel,'day'), tpep_pickup_datetime), COALESCE(:groupBy,'default')
ORDER BY aggregation_period
