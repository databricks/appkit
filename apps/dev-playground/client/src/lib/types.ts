export interface DashboardFilters {
  apps: string;
  creator: string;
  tags: string;
  dateRange: string;
  customDateRange?: {
    startDate: Date;
    endDate: Date;
  };
}

export interface Aggregation {
  period: "daily" | "weekly" | "monthly";
}

export interface SummaryMetrics {
  totalSpend: number;
  totalSpendChange: string;
  forecastedSpend: number;
  forecastedSpendChange: string;
  averageSpend: number;
  averageSpendPeriod: string;
}

export interface ChartGrouping {
  usageTrends: "default" | "app" | "user";
  topContributors: "user" | "app";
}

export interface UsageTrendData {
  period: string;
  amount: number;
  day?: string;
}

export interface TopContributor {
  name: string;
  amount: number;
  percentage: number;
}

export interface ChatMessage {
  id: string;
  message: string;
  response: string;
  timestamp: Date;
}
