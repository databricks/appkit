/** App Analytics v1 fields encoded as OTLP log attributes. */
export const APP_ANALYTICS_SCHEMA_VERSION = 1;

const DATA_SPEC_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

const RESERVED_APPLICATION_NAMES = new Set([
  "browser",
  "databricks",
  "distinctid",
  "distinct_id",
  "enduser",
  "event",
  "session",
  "telemetry",
  "url",
  "user",
]);

const SENSITIVE_PROPERTY_SEGMENTS = new Set([
  "authorization",
  "cookie",
  "email",
  "ip",
  "password",
  "secret",
  "token",
  "username",
]);

const RESERVED_APPLICATION_PREFIXES = [
  "browser.",
  "databricks.",
  "enduser.",
  "event.",
  "session.",
  "telemetry.",
  "url.",
  "user.",
];

export const APP_ANALYTICS_EVENT_NAMES = {
  pageView: "page_view",
} as const;

export const APP_ANALYTICS_ATTRIBUTE_NAMES = {
  eventId: "databricks.app.analytics.event.id",
  eventName: "databricks.app.analytics.event.name",
  eventType: "databricks.app.analytics.event.type",
  pagePath: "databricks.app.analytics.page.path",
  propertyPrefix: "databricks.app.analytics.properties.",
  schemaVersion: "databricks.app.analytics.schema.version",
  sessionId: "databricks.app.analytics.session.id",
  webVitalDelta: "databricks.app.analytics.web_vital.delta",
  webVitalNavigationType: "databricks.app.analytics.web_vital.navigation_type",
  webVitalRating: "databricks.app.analytics.web_vital.rating",
  webVitalSampleId: "databricks.app.analytics.web_vital.sample_id",
  webVitalUnit: "databricks.app.analytics.web_vital.unit",
  webVitalValue: "databricks.app.analytics.web_vital.value",
} as const;

export function applicationPropertyAttributeName(key: string): string {
  return `${APP_ANALYTICS_ATTRIBUTE_NAMES.propertyPrefix}${key}`;
}

/** Restricts application-defined names to the App Analytics v1 grammar. */
function isValidDataSpecName(value: string): boolean {
  return DATA_SPEC_NAME_PATTERN.test(value);
}

/** Prevents application data from impersonating reserved fields. */
export function isValidApplicationName(value: string): boolean {
  if (!isValidDataSpecName(value)) return false;

  const normalized = value.toLowerCase();
  return (
    !RESERVED_APPLICATION_NAMES.has(normalized) &&
    !RESERVED_APPLICATION_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

export function isValidPropertyName(value: string): boolean {
  if (!isValidApplicationName(value)) return false;
  return !value
    .toLowerCase()
    .split(/[._]/)
    .some((segment) => SENSITIVE_PROPERTY_SEGMENTS.has(segment));
}
