-- Top contributors by pickup ZIP (stands in for "app") with aggregation support.
-- @param aggregationLevel STRING
-- @param startDate DATE
-- @param endDate DATE
-- NOTE: 2016-only data; :startDate/:endDate are no-op guards (see spend_data).
WITH agg AS (
  SELECT CAST(pickup_zip AS STRING) AS app_name,
    CASE WHEN :aggregationLevel='weekly'  THEN date_trunc('week', tpep_pickup_datetime)
         WHEN :aggregationLevel='monthly' THEN date_trunc('month', tpep_pickup_datetime)
         ELSE date(tpep_pickup_datetime) END AS period,
    SUM(fare_amount) AS cost_usd
  FROM samples.nyctaxi.trips
  WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2017-01-01'
    AND (COALESCE(CAST(:startDate AS DATE), DATE'2016-01-01') IS NOT NULL)
    AND (COALESCE(CAST(:endDate   AS DATE), DATE'2016-12-31') IS NOT NULL)
    AND pickup_zip IS NOT NULL
  GROUP BY pickup_zip, period)
SELECT app_name, ROUND(SUM(cost_usd),2) AS total_cost_usd
FROM agg GROUP BY app_name ORDER BY total_cost_usd DESC LIMIT 10
