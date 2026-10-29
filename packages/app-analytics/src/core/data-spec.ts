/** App Analytics v1 fields encoded as OTLP log attributes. */
export const APP_ANALYTICS_SCHEMA_VERSION = 1;

/** Maximum length of an Action name or a property key, in UTF-16 units. */
export const MAX_NAME_LENGTH = 128;

/**
 * Property-key namespaces that describe identity, sessions, URLs, or SDK and
 * platform fields. Property keys are always nested under
 * `databricks.app.analytics.properties.`, so these cannot collide with real
 * attributes; they are rejected to keep identity and platform data out of
 * application properties.
 */
const RESERVED_PROPERTY_NAMESPACES = [
  "browser",
  "databricks",
  "enduser",
  "event",
  "session",
  "telemetry",
  "url",
  "user",
];

/**
 * Words that mark a property key as likely to carry credentials or personal
 * data. Keys are split into words in any casing style (`user_email`,
 * `userEmail`, `User Email`, `user-email`), and a key is rejected when one
 * word, or two adjacent words joined (`user` + `name`), is in this set.
 *
 * This is a guard rail for obvious mistakes, not a privacy boundary: it
 * inspects keys, never values.
 */
const SENSITIVE_PROPERTY_WORDS = new Set([
  "authorization",
  "cookie",
  "distinctid",
  "email",
  "ip",
  "password",
  "secret",
  "token",
  "username",
]);

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

/**
 * Accepts any naming convention the application chooses (`order_exported`,
 * `orderExported`, `Order Exported`). Only hygiene is enforced: 1 to 128
 * characters, not blank, no leading or trailing whitespace, and no control or
 * bidirectional-override characters.
 */
export function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    value.trim() === value &&
    !hasControlCharacter(value)
  );
}

type PropertyNameIssue = "invalid_name" | "sensitive_name";

/** Returns why a property key is rejected, or undefined when it is accepted. */
export function propertyNameIssue(key: string): PropertyNameIssue | undefined {
  if (!isValidName(key)) return "invalid_name";

  const normalized = key.toLowerCase();
  const isReserved = RESERVED_PROPERTY_NAMESPACES.some(
    (namespace) =>
      normalized === namespace || normalized.startsWith(`${namespace}.`),
  );
  return isReserved || hasSensitiveWord(key) ? "sensitive_name" : undefined;
}

function hasSensitiveWord(key: string): boolean {
  const words = splitWords(key);
  return words.some(
    (word, index) =>
      SENSITIVE_PROPERTY_WORDS.has(word) ||
      SENSITIVE_PROPERTY_WORDS.has(`${word}${words[index + 1] ?? ""}`),
  );
}

/** Splits a key into lowercase words across snake, kebab, camel, and Pascal case. */
function splitWords(key: string): string[] {
  return key
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}
