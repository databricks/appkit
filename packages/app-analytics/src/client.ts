import { createActionEvent, createAutocapturedActionEvent } from "./action";
import {
  MAX_AUTOCAPTURE_EVENTS_PER_SESSION,
  observeAutocapture,
  type AutocaptureInteraction,
} from "./autocapture";
import {
  createEventContext,
  createEventId,
  getOrCreateSessionId,
  markSessionActivity,
  readPageLocation,
} from "./core/context";
import { DeliveryPipeline } from "./core/delivery";
import type {
  BrowserEvent,
  BrowserEventMetadata,
  EventProperties,
  AppAnalyticsDiagnostic,
  AppAnalyticsEvent,
} from "./core/event";
import {
  DEFAULT_SAMPLE_RATE,
  isSessionSampled,
  normalizeSampleRate,
} from "./core/sampling";
import { createPageViewEvent } from "./page";
import { observePageChanges } from "./page/navigation";
import {
  createWebVitalEvent,
  observeWebVitals,
  type WebVitalMetric,
} from "./web-vitals";

export const DEFAULT_ENDPOINT = "/_analytics/v1/logs";

const DEFAULT_WEB_VITALS_SUBSCRIBER_KEY = Symbol.for(
  "@databricks/app-analytics/default-web-vitals-client",
);
const DEFAULT_AUTOCAPTURE_SUBSCRIBER_KEY = Symbol.for(
  "@databricks/app-analytics/default-autocapture-client",
);

interface InstrumentationSubscriberKeys {
  autocapture: object | symbol;
  webVitals: object | symbol;
}

export interface AppAnalyticsOptions {
  /** Same-origin endpoint that receives OTLP/HTTP JSON. */
  endpoint?: string;
  /** Track the initial page and History API navigation. Defaults to true. */
  automaticPageViews?: boolean;
  /** Track explicitly annotated clicks and form submissions. Defaults to false. */
  autocapture?: boolean;
  /** Collect LCP, INP, CLS, FCP, and TTFB. Defaults to false. */
  webVitals?: boolean;
  /** Fraction of browser sessions to collect, from 0 to 1. Defaults to 1. */
  sampleRate?: number;
  /** Return false to discard an event before it enters the delivery queue. */
  beforeSend?: (event: AppAnalyticsEvent) => boolean | void;
  /** Receives sanitized SDK diagnostics that never include event content. */
  onDiagnostic?: (diagnostic: AppAnalyticsDiagnostic) => void;
}

export interface AppAnalyticsClient {
  init(options?: AppAnalyticsOptions): void;
  track(name: string, properties?: EventProperties): void;
  page(properties?: EventProperties): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

class BrowserAppAnalyticsClient implements AppAnalyticsClient {
  private autocaptureEventCount = 0;
  private autocaptureLimitReported = false;
  private beforeSend: AppAnalyticsOptions["beforeSend"];
  private readonly delivery = new DeliveryPipeline((diagnostic) => {
    this.reportDiagnostic(diagnostic);
  });
  private endpoint = DEFAULT_ENDPOINT;
  private initialized = false;
  private lastPageLocation: string | undefined;
  private onDiagnostic: AppAnalyticsOptions["onDiagnostic"];
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private sampled: boolean | undefined;
  private sessionId: string | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private stopObservingAutocapture: (() => void) | undefined;
  private stopObservingPageChanges: (() => void) | undefined;
  private stopObservingWebVitals: (() => void) | undefined;
  private readonly recordWebVital = (
    metric: WebVitalMetric,
    documentLocation: { path: string },
  ): void => {
    this.record((metadata) =>
      createWebVitalEvent(metric, metadata, documentLocation),
    );
  };

  private readonly recordAutocapture = (
    interaction: AutocaptureInteraction,
  ): void => {
    if (this.autocaptureEventCount >= MAX_AUTOCAPTURE_EVENTS_PER_SESSION) {
      if (!this.autocaptureLimitReported) {
        this.autocaptureLimitReported = true;
        this.reportDiagnostic({
          code: "autocapture_limit_reached",
          eventCount: 1,
        });
      }
      return;
    }

    const event = this.record((metadata) =>
      createAutocapturedActionEvent(
        interaction.eventName,
        interaction,
        metadata,
      ),
    );
    if (event !== null) this.autocaptureEventCount += 1;
  };

  constructor(private readonly subscriberKeys: InstrumentationSubscriberKeys) {}

  init(options: AppAnalyticsOptions = {}): void {
    if (this.shutdownPromise !== undefined) return;

    this.endpoint = normalizeEndpoint(options.endpoint);
    this.beforeSend =
      typeof options.beforeSend === "function" ? options.beforeSend : undefined;
    this.onDiagnostic =
      typeof options.onDiagnostic === "function"
        ? options.onDiagnostic
        : undefined;
    this.sampleRate = normalizeSampleRate(options.sampleRate);
    this.initialized = true;
    this.delivery.start();

    if (options.automaticPageViews === false) {
      this.stopAutomaticPageViews();
    } else {
      this.startAutomaticPageViews();
    }

    if (options.autocapture === true) {
      this.startAutocapture();
    } else {
      this.stopAutocapture();
    }

    if (options.webVitals === true) {
      this.startWebVitals();
    } else {
      this.stopWebVitals();
    }
  }

  track(name: string, properties: EventProperties = {}): void {
    this.record((metadata) => createActionEvent(name, properties, metadata));
  }

  page(properties: EventProperties = {}): void {
    if (!this.initialized) return;

    const location = readPageLocation();
    const event = this.record((metadata) =>
      createPageViewEvent(properties, metadata),
    );
    this.lastPageLocation = pageLocationKey(event?.context ?? location);
  }

  private record(
    createEvent: (metadata: BrowserEventMetadata) => BrowserEvent | null,
  ): BrowserEvent | null {
    if (!this.initialized) return null;

    try {
      const timestamp = Date.now();
      const sessionId = this.sampledSessionId(timestamp);
      if (sessionId === undefined) return null;

      const event = createEvent({
        id: createEventId(),
        timestamp,
        context: createEventContext(sessionId),
      });

      if (event === null) return null;
      if (!this.runBeforeSend(event)) return null;
      if (!this.delivery.enqueue(this.endpoint, event)) return null;

      markSessionActivity(sessionId, timestamp);
      return event;
    } catch {
      // Instrumentation must not change the behavior of the host application.
      return null;
    }
  }

  private startAutomaticPageViews(): void {
    if (typeof window === "undefined") return;

    // The initial page view must not depend on History API instrumentation.
    this.recordPageViewIfLocationChanged();

    if (this.stopObservingPageChanges !== undefined) return;

    const stopObserving = observePageChanges(() => {
      this.recordPageViewIfLocationChanged();
    });
    if (stopObserving === undefined) return;

    this.stopObservingPageChanges = stopObserving;
  }

  private stopAutomaticPageViews(): void {
    this.stopObservingPageChanges?.();
    this.stopObservingPageChanges = undefined;
    this.lastPageLocation = undefined;
  }

  private recordPageViewIfLocationChanged(): void {
    const location = readPageLocation();
    if (pageLocationKey(location) === this.lastPageLocation) return;
    this.page();
  }

  private startWebVitals(): void {
    if (this.stopObservingWebVitals !== undefined) return;
    try {
      if (this.sampledSessionId() === undefined) return;
    } catch {
      return;
    }
    this.stopObservingWebVitals = observeWebVitals(
      this.recordWebVital,
      this.subscriberKeys.webVitals,
    );
  }

  private stopWebVitals(): void {
    this.stopObservingWebVitals?.();
    this.stopObservingWebVitals = undefined;
  }

  private startAutocapture(): void {
    if (this.stopObservingAutocapture !== undefined) return;
    try {
      if (this.sampledSessionId() === undefined) return;
    } catch {
      return;
    }
    try {
      this.stopObservingAutocapture = observeAutocapture(
        this.recordAutocapture,
        this.subscriberKeys.autocapture,
      );
    } catch {
      // DOM instrumentation must not affect application initialization.
    }
  }

  private stopAutocapture(): void {
    this.stopObservingAutocapture?.();
    this.stopObservingAutocapture = undefined;
  }

  private sampledSessionId(now = Date.now()): string | undefined {
    const sessionId = getOrCreateSessionId(now);
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.sampled = undefined;
      this.autocaptureEventCount = 0;
      this.autocaptureLimitReported = false;
    }
    this.sampled ??= isSessionSampled(sessionId, this.sampleRate);
    return this.sampled ? sessionId : undefined;
  }

  async flush(): Promise<void> {
    await this.delivery.flush();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;

    this.initialized = false;
    this.stopAutomaticPageViews();
    this.stopAutocapture();
    this.stopWebVitals();
    const operation = this.delivery.shutdown().finally(() => {
      this.beforeSend = undefined;
      this.onDiagnostic = undefined;
      this.autocaptureEventCount = 0;
      this.autocaptureLimitReported = false;
      this.sampleRate = DEFAULT_SAMPLE_RATE;
      this.sampled = undefined;
      this.sessionId = undefined;
      this.shutdownPromise = undefined;
    });
    this.shutdownPromise = operation;
    return operation;
  }

  private runBeforeSend(event: BrowserEvent): boolean {
    if (this.beforeSend === undefined) return true;

    try {
      return this.beforeSend(createEventSnapshot(event)) !== false;
    } catch {
      this.reportDiagnostic({ code: "before_send_error", eventCount: 1 });
      return false;
    }
  }

  private reportDiagnostic(diagnostic: AppAnalyticsDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and must not affect application code.
    }
  }
}

function createEventSnapshot(event: BrowserEvent): AppAnalyticsEvent {
  const context = Object.freeze({ ...event.context });
  const properties = Object.freeze({ ...event.properties });
  const webVital =
    event.webVital === undefined
      ? undefined
      : Object.freeze({ ...event.webVital });
  return Object.freeze({ ...event, context, properties, webVital });
}

function pageLocationKey(location: { path: string }): string {
  return location.path;
}

function normalizeEndpoint(endpoint: string | undefined): string {
  const fallback = resolveDefaultEndpoint();
  if (typeof endpoint !== "string") return fallback;

  const normalized = endpoint.trim();
  if (normalized.length === 0 || normalized.startsWith("//")) {
    return fallback;
  }

  if (typeof window === "undefined") {
    return /^[a-z][a-z\d+.-]*:/i.test(normalized) ? fallback : normalized;
  }

  try {
    const resolved = new URL(normalized, window.location.href);
    const isSameOrigin = resolved.origin === window.location.origin;
    const hasCredentials =
      resolved.username.length > 0 || resolved.password.length > 0;
    return isSameOrigin && !hasCredentials ? resolved.href : fallback;
  } catch {
    return fallback;
  }
}

function resolveDefaultEndpoint(): string {
  if (typeof window === "undefined") return DEFAULT_ENDPOINT;

  try {
    return new URL(DEFAULT_ENDPOINT, window.location.href).href;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

export function createAppAnalytics(): AppAnalyticsClient {
  const subscriberKey = {};
  return new BrowserAppAnalyticsClient({
    autocapture: subscriberKey,
    webVitals: subscriberKey,
  });
}

export const appAnalytics = new BrowserAppAnalyticsClient({
  autocapture: DEFAULT_AUTOCAPTURE_SUBSCRIBER_KEY,
  webVitals: DEFAULT_WEB_VITALS_SUBSCRIBER_KEY,
});
