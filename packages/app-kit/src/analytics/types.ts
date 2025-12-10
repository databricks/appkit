import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
}

export interface AnalyticsQueryResponse {
  chunk_index: number;
  row_offset: number;
  row_count: number;
  data: any[];
}
