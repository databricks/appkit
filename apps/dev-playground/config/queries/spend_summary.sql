SELECT
  ROUND(SUM(u.usage_quantity * lp.pricing.effective_list.default)) AS total,
  ROUND(SUM(u.usage_quantity * lp.pricing.effective_list.default) /
    CASE
      WHEN COALESCE(:aggregationLevel, 'day') = 'week' THEN CEIL(DATEDIFF(:endDate, :startDate) / 7.0)
      WHEN COALESCE(:aggregationLevel, 'day') = 'month' THEN CEIL(DATEDIFF(:endDate, :startDate) / 30.0)
      ELSE DATEDIFF(:endDate, :startDate) + 1
    END) AS average,
  ROUND(SUM(u.usage_quantity * lp.pricing.effective_list.default) * 1.2) AS forecasted
FROM system.billing.usage AS u
JOIN system.billing.list_prices AS lp
  ON u.sku_name = lp.sku_name
  AND u.cloud = lp.cloud
  AND u.usage_end_time >= lp.price_start_time
  AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
WHERE u.billing_origin_product = 'APPS'
  AND u.workspace_id = :workspaceId
  AND u.usage_date BETWEEN :startDate AND :endDate