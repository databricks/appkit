import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
}
