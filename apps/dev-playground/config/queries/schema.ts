import { z } from "zod";

export const querySchemas = {
  apps_list: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      creator: z.string(),
      tags: z.array(z.string()),
      totalSpend: z.number(),
      createdAt: z.string(),
    }),
  ),

  spend_summary: z.array(
    z.object({
      total: z.number(),
      average: z.number(),
      forecasted: z.number(),
    }),
  ),

  untagged_apps: z.array(
    z.object({
      app_name: z.string(),
      creator: z.string(),
      total_cost_usd: z.number(),
      avg_period_cost_usd: z.number(),
    }),
  ),

  spend_data: z.array(
    z.object({
      group_key: z.string(),
      aggregation_period: z.string(),
      cost_usd: z.number(),
    }),
  ),

  top_contributors: z.array(
    z.object({
      app_name: z.string(),
      total_cost_usd: z.number(),
    }),
  ),
  sql_helpers_test: z.object({
    string_value: z.string(),
    number_value: z.number(),
    boolean_value: z.boolean(),
    date_value: z.string(),
    timestamp_value: z.string(),
    binary_value: z.string(),
    binary_hex: z.string(),
    binary_length: z.number(),
  }),
};
