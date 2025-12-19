WITH app_spend AS (
  SELECT 
    u.usage_metadata.app_name,
    u.identity_metadata.created_by,
    SUM(u.usage_quantity * lp.pricing.effective_list.default) as spend,
    MIN(u.usage_date) as first_usage_date
  FROM system.billing.usage AS u
  JOIN system.billing.list_prices AS lp 
    ON u.sku_name = lp.sku_name 
    AND u.cloud = lp.cloud 
    AND u.usage_end_time >= lp.price_start_time 
    AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
  WHERE u.billing_origin_product = 'APPS' 
    AND u.usage_date >= DATE_SUB(CURRENT_DATE(), 30) 
    AND u.usage_metadata.app_name IS NOT NULL
  GROUP BY u.usage_metadata.app_name, u.identity_metadata.created_by
),
app_primary_creator AS (
  SELECT 
    app_name,
    FIRST(created_by) as primary_creator
  FROM (
    SELECT 
      app_name, 
      created_by,
      first_usage_date
    FROM app_spend
    ORDER BY app_name, first_usage_date
  )
  GROUP BY app_name
)
SELECT 
  a.app_name as id,
  a.app_name as name,
  apc.primary_creator as creator,
  '[]' as tags,
  SUM(a.spend) as totalSpend,
  MIN(a.first_usage_date) as createdAt
FROM app_spend a
JOIN app_primary_creator apc ON a.app_name = apc.app_name
GROUP BY a.app_name, apc.primary_creator
ORDER BY totalSpend DESC
LIMIT 10

