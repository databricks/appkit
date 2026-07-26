-- @param aggregationLevel STRING
-- @param startDate DATE
-- @param endDate DATE
-- NOTE: samples.nyctaxi.trips is 2016-only; data window pinned to 2016.
SELECT ROUND(SUM(fare_amount)) AS total,
  ROUND(SUM(fare_amount) / CASE
    WHEN COALESCE(:aggregationLevel,'day')='week'  THEN CEIL(DATEDIFF(:endDate,:startDate)/7.0)
    WHEN COALESCE(:aggregationLevel,'day')='month' THEN CEIL(DATEDIFF(:endDate,:startDate)/30.0)
    ELSE DATEDIFF(:endDate,:startDate)+1 END) AS average,
  ROUND(SUM(fare_amount)*1.2) AS forecasted
FROM samples.nyctaxi.trips
WHERE tpep_pickup_datetime >= TIMESTAMP'2016-01-01' AND tpep_pickup_datetime < TIMESTAMP'2016-02-01'
