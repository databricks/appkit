import type { MetricFilter } from "../types";

export interface FilterRenderState {
  counter: number;
  depth: number;
}

export interface MetricCacheKeyInput {
  metricKey: string;
  source: string;
  measures: string[];
  dimensions?: string[];
  timeGrain?: string;
  timeDimension?: string;
  filter?: MetricFilter;
  format: string;
  executorKey: string;
  limit?: number;
}
