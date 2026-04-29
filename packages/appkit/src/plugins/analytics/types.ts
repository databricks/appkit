import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export type AnalyticsFormat = "JSON_ARRAY" | "ARROW_STREAM";
export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
  format?: AnalyticsFormat;
}

export interface AnalyticsQueryResponse {
  chunk_index: number;
  row_offset: number;
  row_count: number;
  data: any[];
}
