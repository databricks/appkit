SELECT 
  u.usage_metadata.app_name AS app_name,
  SUM(u.usage_quantity * lp.pricing.effective_list.default) AS total_cost_usd
FROM system.billing.usage AS u
JOIN system.billing.list_prices AS lp 
  ON u.sku_name = lp.sku_name 
  AND u.cloud = lp.cloud 
  AND u.usage_end_time >= lp.price_start_time 
  AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
WHERE u.billing_origin_product = 'APPS' 
  AND u.workspace_id = :workspaceId 
  AND u.usage_date BETWEEN :startDate AND :endDate
GROUP BY u.usage_metadata.app_name
ORDER BY total_cost_usd DESC
LIMIT 10