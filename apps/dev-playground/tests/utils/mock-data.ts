/**
 * Mock data for dev-playground frontend integration tests
 * These mock responses simulate the API responses from the backend
 */

// Analytics mock data
export const mockAnalyticsData = {
  spendSummary: [
    {
      total: 15000,
      average: 500,
      forecasted: 18000,
    },
  ],

  appsList: [
    {
      id: 1,
      name: "App One",
      creator: "user1@databricks.com",
      totalSpend: 5000,
      tags: ["prod", "analytics"],
      createdAt: "2024-01-15T10:30:00Z",
    },
    {
      id: 2,
      name: "App Two",
      creator: "user2@databricks.com",
      totalSpend: 3500,
      tags: ["staging"],
      createdAt: "2024-02-20T14:45:00Z",
    },
    {
      id: 3,
      name: "App Three",
      creator: "user3@databricks.com",
      totalSpend: 2200,
      tags: [],
      createdAt: "2024-03-10T09:00:00Z",
    },
  ],

  untaggedApps: [
    {
      app_name: "Untagged App 1",
      creator: "user4@databricks.com",
      total_cost_usd: 1200,
      avg_period_cost_usd: 400,
    },
    {
      app_name: "Untagged App 2",
      creator: "user5@databricks.com",
      total_cost_usd: 800,
      avg_period_cost_usd: 266,
    },
  ],

  spendData: [
    {
      aggregation_period: "2024-01-01",
      cost_usd: 1200,
      group_key: "default",
    },
    {
      aggregation_period: "2024-01-02",
      cost_usd: 1350,
      group_key: "default",
    },
    {
      aggregation_period: "2024-01-03",
      cost_usd: 980,
      group_key: "default",
    },
    {
      aggregation_period: "2024-01-04",
      cost_usd: 1500,
      group_key: "default",
    },
    {
      aggregation_period: "2024-01-05",
      cost_usd: 1100,
      group_key: "default",
    },
  ],

  topContributors: [
    { app_name: "Top App 1", total_cost_usd: 5000 },
    { app_name: "Top App 2", total_cost_usd: 3500 },
    { app_name: "Top App 3", total_cost_usd: 2800 },
    { app_name: "Top App 4", total_cost_usd: 2200 },
    { app_name: "Top App 5", total_cost_usd: 1500 },
  ],

  appActivityHeatmap: [
    { app_name: "App One", day_of_week: "Monday", spend: 500 },
    { app_name: "App One", day_of_week: "Tuesday", spend: 600 },
    { app_name: "App One", day_of_week: "Wednesday", spend: 450 },
    { app_name: "App Two", day_of_week: "Monday", spend: 300 },
    { app_name: "App Two", day_of_week: "Tuesday", spend: 400 },
    { app_name: "App Two", day_of_week: "Wednesday", spend: 350 },
  ],

  sqlHelpersTest: [
    {
      string_value: "Hello, Databricks!",
      number_value: 42,
      boolean_value: true,
      date_value: "2024-01-15",
      timestamp_value: "2024-01-15T10:30:00Z",
      binary_value: "Spark",
      binary_hex: "537061726B",
      binary_length: 5,
    },
  ],
};

// Reconnect/SSE mock data
export const mockReconnectMessages = [
  {
    type: "message",
    count: 1,
    total: 5,
    timestamp: new Date().toISOString(),
    content: "Message 1 of 5",
  },
  {
    type: "message",
    count: 2,
    total: 5,
    timestamp: new Date().toISOString(),
    content: "Message 2 of 5",
  },
  {
    type: "message",
    count: 3,
    total: 5,
    timestamp: new Date().toISOString(),
    content: "Message 3 of 5",
  },
  {
    type: "message",
    count: 4,
    total: 5,
    timestamp: new Date().toISOString(),
    content: "Message 4 of 5",
  },
  {
    type: "message",
    count: 5,
    total: 5,
    timestamp: new Date().toISOString(),
    content: "Message 5 of 5",
  },
];

// Telemetry mock data
export const mockTelemetryResponse = {
  success: true,
  message: "Telemetry example completed successfully",
  duration_ms: 150,
  result: { items_processed: 5 },
  tracing: {
    hint: "View traces in Grafana",
    services: ["telemetry-examples"],
    expectedSpans: [
      "telemetry-examples.combined",
      "cache-lookup",
      "http-request",
    ],
  },
  metrics: {
    recorded: [
      "telemetry_examples.requests_total",
      "telemetry_examples.request_duration_ms",
    ],
  },
  logs: {
    emitted: ["Processing started", "Cache miss", "Processing completed"],
  },
};
