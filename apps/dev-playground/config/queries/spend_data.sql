SELECT
  COALESCE(:groupBy, 'default') as group_key,
  date_trunc(COALESCE(:aggregationLevel, 'day'), u.usage_date) AS aggregation_period,
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
  AND (COALESCE(:appId, 'all') = 'all' OR u.usage_metadata.app_name = COALESCE(:appId, 'all'))
  AND (COALESCE(:creator, 'all') = 'all' OR u.identity_metadata.created_by = COALESCE(:creator, 'all'))
GROUP BY date_trunc(COALESCE(:aggregationLevel, 'day'), u.usage_date)
ORDER BY aggregation_period DESC
