import type { BasePluginConfig } from "shared";
import { z } from "zod";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
}

export const analyticsQueryResponseSchema = z.object({
  chunk_index: z.number(),
  row_offset: z.number(),
  row_count: z.number(),
  data: z.array(z.any()),
});
