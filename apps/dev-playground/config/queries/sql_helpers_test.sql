-- @param stringParam STRING
-- @param numberParam NUMERIC
-- @param booleanParam BOOLEAN
-- @param dateParam DATE
-- @param timestampParam TIMESTAMP
-- @param binaryParam STRING
SELECT
  :stringParam as string_value,
  :numberParam as number_value,
  :booleanParam as boolean_value,
  :dateParam as date_value,
  :timestampParam as timestamp_value,
  UNHEX(:binaryParam) as binary_value,
  :binaryParam as binary_hex,
  LENGTH(UNHEX(:binaryParam)) as binary_length
