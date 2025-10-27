-- Top contributors by app with aggregation support
-- Parameters: workspaceId, startDate, endDate, aggregationLevel (daily, weekly, monthly)
WITH aggregated_costs AS (
  SELECT 
    u.usage_metadata.app_name AS app_name,
    CASE 
      WHEN :aggregationLevel = 'daily' THEN DATE(u.usage_date)
      WHEN :aggregationLevel = 'weekly' THEN DATE_TRUNC('week', u.usage_date)
      WHEN :aggregationLevel = 'monthly' THEN DATE_TRUNC('month', u.usage_date)
      ELSE DATE(u.usage_date)
    END AS period,
    SUM(u.usage_quantity * lp.pricing.effective_list.default) AS cost_usd
  FROM system.billing.usage AS u
  JOIN system.billing.list_prices AS lp 
    ON u.sku_name = lp.sku_name 
    AND u.cloud = lp.cloud 
    AND u.usage_end_time >= lp.price_start_time 
    AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
  WHERE u.billing_origin_product = 'APPS' 
    AND u.workspace_id = :workspaceId 
    AND u.usage_date BETWEEN :startDate AND :endDate
    AND u.usage_metadata.app_name IS NOT NULL
  GROUP BY u.usage_metadata.app_name, period
)
SELECT 
  app_name,
  SUM(cost_usd) AS total_cost_usd
FROM aggregated_costs
GROUP BY app_name
ORDER BY total_cost_usd DESC
LIMIT 10