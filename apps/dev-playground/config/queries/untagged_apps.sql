WITH app_periods AS (
  SELECT
    u.usage_metadata.app_name AS app_name,
    u.identity_metadata.created_by AS creator,
    date_trunc(COALESCE(:aggregationLevel, 'day'), u.usage_date) AS period,
    SUM(u.usage_quantity * lp.pricing.effective_list.default) AS period_cost_usd
  FROM system.billing.usage AS u
  JOIN system.billing.list_prices AS lp
    ON u.sku_name = lp.sku_name
    AND u.cloud = lp.cloud
    AND u.usage_end_time >= lp.price_start_time
    AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
  WHERE (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
    AND u.billing_origin_product = 'APPS'
    AND u.workspace_id = :workspaceId
    AND u.usage_date BETWEEN :startDate AND :endDate
  GROUP BY u.usage_metadata.app_name, u.identity_metadata.created_by, date_trunc(COALESCE(:aggregationLevel, 'day'), u.usage_date)
)
SELECT
  app_name,
  creator,
  SUM(period_cost_usd) AS total_cost_usd,
  AVG(period_cost_usd) AS avg_period_cost_usd
FROM app_periods
GROUP BY app_name, creator
ORDER BY total_cost_usd DESC
LIMIT 100

