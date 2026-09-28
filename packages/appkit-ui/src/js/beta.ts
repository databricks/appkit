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
  type AppAnalyticsEventType,
  type AppAnalyticsOptions,
  appAnalytics,
  type BeforeSendResult,
  createAppAnalytics,
  type EventContext,
  type EventProperties,
  type EventPropertyValue,
  type WebVitalEventData,
  type WebVitalName,
  type WebVitalNavigationType,
  type WebVitalRating,
} from "@databricks/app-analytics";
