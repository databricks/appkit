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

export type AppAnalyticsDiagnosticCode =
  | "autocapture_limit_reached"
  | "before_send_error"
  | "delivery_failed"
  | "delivery_retry"
  | "event_too_large"
  | "queue_overflow";

export type AppAnalyticsDiagnosticReason =
  | "encoding"
  | "http"
  | "network"
  | "timeout"
  | "unavailable";

/** Sanitized delivery metadata. Event content is never included. */
export interface AppAnalyticsDiagnostic {
  readonly code: AppAnalyticsDiagnosticCode;
  readonly eventCount: number;
  readonly attempt?: number;
  readonly reason?: AppAnalyticsDiagnosticReason;
  readonly status?: number;
}
