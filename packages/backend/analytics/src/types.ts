import type { BasePluginConfig } from "@databricks-apps/types";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
}
