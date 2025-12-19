-- App activity heatmap: shows spend by app and day of week
-- Perfect for visualizing usage patterns
-- @param startDate DATE
-- @param endDate DATE
SELECT 
  u.usage_metadata.app_name AS app_name,
  DAYNAME(u.usage_date) AS day_of_week,
  ROUND(SUM(u.usage_quantity * lp.pricing.effective_list.default), 2) AS spend
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
GROUP BY u.usage_metadata.app_name, DAYNAME(u.usage_date)
ORDER BY 
  CASE DAYNAME(u.usage_date)
    WHEN 'Monday' THEN 1
    WHEN 'Tuesday' THEN 2
    WHEN 'Wednesday' THEN 3
    WHEN 'Thursday' THEN 4
    WHEN 'Friday' THEN 5
    WHEN 'Saturday' THEN 6
    WHEN 'Sunday' THEN 7
  END,
  spend DESC

