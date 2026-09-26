// Beta JS utilities -- APIs may change between minor releases.
// Import from '@databricks/appkit-ui/js' once graduated to stable.

// App Analytics browser SDK. Posts OTLP log records to the server plugin's
// built-in /_analytics/v1/logs relay, which forwards them to the Databricks
// Apps OTel Collector.
export {
  type AppAnalyticsClient,
  type AppAnalyticsDiagnostic,
  type AppAnalyticsDiagnosticCode,
  type AppAnalyticsDiagnosticReason,
  type AppAnalyticsEvent,
  type AppAnalyticsOptions,
  appAnalytics,
  createAppAnalytics,
  type EventProperties,
  type EventPropertyValue,
} from "@databricks/app-analytics";
