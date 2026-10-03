import { version as packageVersion } from "../../package.json";

export const SDK_NAME = "@databricks/app-analytics";
export const SDK_VERSION = packageVersion;

export type EventPropertyValue = string | number | boolean;
export type AppAnalyticsEventType = "action" | "page_view" | "web_vital";
export type WebVitalName = "cls" | "fcp" | "inp" | "lcp" | "ttfb";
export type WebVitalRating = "good" | "needs_improvement" | "poor";
export type WebVitalNavigationType =
  | "navigate"
  | "reload"
  | "back_forward"
  | "back_forward_cache"
  | "prerender"
  | "restore";

export interface WebVitalEventData {
  value: number;
  unit: "ms" | "score";
  delta: number;
  sampleId: string;
  rating: WebVitalRating;
  navigationType?: WebVitalNavigationType;
}

/** Flat event attributes. Nullish values are accepted and omitted. */
export type EventProperties = Readonly<
  Record<string, EventPropertyValue | null | undefined>
>;

export interface EventContext {
  sessionId: string;
  path: string;
  sdkName: typeof SDK_NAME;
  sdkVersion: string;
}

export interface BrowserEventMetadata {
  id: string;
  timestamp: number;
  context: EventContext;
}

/** Browser-observable event data. Identity is supplied by the trusted network. */
export interface BrowserEvent extends BrowserEventMetadata {
  name: string;
  type: AppAnalyticsEventType;
  properties: Record<string, EventPropertyValue>;
  webVital?: WebVitalEventData;
}

/** Immutable event snapshot exposed to lifecycle hooks before it is queued. */
export interface AppAnalyticsEvent extends Readonly<
  Omit<BrowserEvent, "context" | "properties" | "webVital">
> {
  readonly context: Readonly<EventContext>;
  readonly properties: Readonly<Record<string, EventPropertyValue>>;
  readonly webVital?: Readonly<WebVitalEventData>;
}

/**
 * Diagnostic codes, grouped by what they report:
 *
 * - input the SDK did not accept: `invalid_event_name`, `property_dropped`,
 *   `autocapture_ignored`, `before_send_error`;
 * - bounds reached: `autocapture_limit_reached`, `queue_overflow`,
 *   `event_too_large`;
 * - delivery: `delivery_retry`, `delivery_failed`;
 * - an unexpected SDK failure that was contained: `internal_error`.
 */
export type AppAnalyticsDiagnosticCode =
  | "autocapture_ignored"
  | "autocapture_limit_reached"
  | "before_send_error"
  | "delivery_failed"
  | "delivery_retry"
  | "event_too_large"
  | "internal_error"
  | "invalid_event_name"
  | "property_dropped"
  | "queue_overflow";

/**
 * Why a diagnostic happened. Delivery diagnostics use `encoding`, `http`,
 * `network`, `timeout`, or `unavailable`. `property_dropped` uses
 * `invalid_name`, `sensitive_name`, `invalid_value`, or `limit_exceeded`.
 * `autocapture_ignored` uses `not_interactive`. `before_send_error` uses
 * `invalid_page_path` when the hook returned an unusable path, and has no
 * reason when the hook threw.
 */
export type AppAnalyticsDiagnosticReason =
  | "encoding"
  | "http"
  | "invalid_name"
  | "invalid_page_path"
  | "invalid_value"
  | "limit_exceeded"
  | "network"
  | "not_interactive"
  | "sensitive_name"
  | "timeout"
  | "unavailable";

/** Sanitized SDK metadata. Event names, properties, URLs, and errors are never included. */
export interface AppAnalyticsDiagnostic {
  readonly code: AppAnalyticsDiagnosticCode;
  /** Number of events affected. */
  readonly eventCount: number;
  /** Delivery attempt that produced the diagnostic. */
  readonly attempt?: number;
  /** Number of properties omitted from the event, for `property_dropped`. */
  readonly propertyCount?: number;
  readonly reason?: AppAnalyticsDiagnosticReason;
  /** HTTP status of the delivery response. */
  readonly status?: number;
}

/** Internal sink that SDK modules use to report diagnostics. */
export type DiagnosticSink = (diagnostic: AppAnalyticsDiagnostic) => void;
