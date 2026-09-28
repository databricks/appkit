import { createActionEvent } from "./action";
import {
  MAX_AUTOCAPTURE_EVENTS_PER_SESSION,
  observeAutocapture,
  type AutocaptureSignal,
} from "./autocapture";
import {
  applyBeforeSendResult,
  createEventSnapshot,
  type BeforeSendResult,
} from "./core/before-send";
import {
  createEventContext,
  createEventId,
  getOrCreateSessionId,
  markSessionActivity,
  readPageLocation,
} from "./core/context";
import { DeliveryPipeline } from "./core/delivery";
import type {
  AppAnalyticsDiagnostic,
  AppAnalyticsEvent,
  BrowserEvent,
  BrowserEventMetadata,
  EventProperties,
} from "./core/event";
import { getOrCreateGlobal } from "./core/global-registry";
import { Instrumentation } from "./core/instrumentation";
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

/** Calls made before the first `init()` that are kept and replayed. */
export const MAX_PENDING_CALLS = 100;

const DEFAULT_CLIENT_KEY = Symbol.for("@databricks/app-analytics/client-v1");
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

/**
 * Client options. `init()` merges them into the current configuration: an
 * omitted or `undefined` option keeps its current value, and defaults apply
 * on the first `init()` and after `shutdown()`.
 */
export interface AppAnalyticsOptions {
  /**
   * Same-origin endpoint that receives OTLP/HTTP JSON. Defaults to
   * `/_analytics/v1/logs`. Cross-origin endpoints and endpoints with URL
   * credentials fall back to the default.
   */
  endpoint?: string;
  /** Track the initial page and History API navigation. Defaults to true. */
  automaticPageViews?: boolean;
  /**
   * Track clicks and submits on elements annotated with
   * `data-app-analytics-event`. Unannotated elements are never captured.
   * Defaults to true.
   */
  autocapture?: boolean;
  /**
   * Collect LCP, INP, CLS, FCP, and TTFB. Defaults to false: it adds about
   * five records per page load.
   */
  webVitals?: boolean;
  /**
   * Fraction of browser sessions to collect, from 0 to 1. Defaults to 1. The
   * decision is made once per session, so a new rate applies from the next
   * session.
   */
  sampleRate?: number;
  /**
   * Runs before an event is queued. Return `false` or `null` to drop it,
   * nothing or `true` to keep it, or a copy with a changed `name` (Actions
   * only), `properties`, or `context.path` to redact or group it:
   *
   * ```ts
   * beforeSend: (event) => ({
   *   ...event,
   *   context: { ...event.context, path: event.context.path.replace(/\/\d+/g, "/:id") },
   * })
   * ```
   *
   * Returned values are validated like application input. An invalid name or
   * path drops the event.
   */
  beforeSend?: (event: AppAnalyticsEvent) => BeforeSendResult;
  /**
   * Receives sanitized SDK diagnostics: dropped input, delivery outcomes,
   * and contained failures. Diagnostics never include event content.
   */
  onDiagnostic?: (diagnostic: AppAnalyticsDiagnostic) => void;
}

export interface AppAnalyticsClient {
  /**
   * Starts the client, or updates the running configuration. Options merge
   * into the current configuration, so calling `init()` again changes only
   * the options it passes. Calls made before the first `init()` are kept (up
   * to 100) and sent once it runs. `init()` during `shutdown()` restarts the
   * client when the shutdown completes.
   */
  init(options?: AppAnalyticsOptions): void;
  /**
   * Records an Action. The name is yours to choose in any convention, from 1
   * to 128 characters, without control characters or surrounding whitespace.
   * Keep it low-cardinality and put details in properties.
   *
   * Properties are scalar (string up to 1,024 characters, finite number,
   * boolean), at most 50 per event; nullish values are omitted. Keys that
   * look like credentials or personal data (containing `email`, `password`,
   * `token`, `secret`, `authorization`, `cookie`, `ip`, `username`) or that
   * use the `user.`, `enduser.`, `session.`, `url.`, `event.`, `browser.`,
   * `telemetry.`, or `databricks.` namespaces are omitted. Omitted input is
   * reported through `onDiagnostic`.
   */
  track(name: string, properties?: EventProperties): void;
  /** Records a Page View for the current path, with optional properties. */
  page(properties?: EventProperties): void;
  /**
   * Delivers every event queued before the call. Resolves when delivery was
   * attempted, not when records are persisted.
   */
  flush(): Promise<void>;
  /**
   * Delivers queued events, removes browser observers, and resets the
   * configuration. Events recorded afterwards are dropped until `init()`.
   */
  shutdown(): Promise<void>;
}

type ClientState = "idle" | "running" | "stopping" | "stopped";

/** When and where a call was made, captured for calls replayed after `init()`. */
interface CallContext {
  readonly timestamp: number;
  readonly path: string;
}

type PendingCall =
  | {
      readonly kind: "track";
      readonly name: string;
      readonly properties: EventProperties;
      readonly call: CallContext;
    }
  | {
      readonly kind: "page";
      readonly properties: EventProperties;
      readonly call: CallContext;
    };

interface ClientConfig {
  endpoint: string | undefined;
  beforeSend: AppAnalyticsOptions["beforeSend"];
  onDiagnostic: AppAnalyticsOptions["onDiagnostic"];
  sampleRate: number;
  automaticPageViews: boolean;
  autocapture: boolean;
  webVitals: boolean;
}

function defaultConfig(): ClientConfig {
  return {
    endpoint: undefined,
    beforeSend: undefined,
    onDiagnostic: undefined,
    sampleRate: DEFAULT_SAMPLE_RATE,
    automaticPageViews: true,
    autocapture: true,
    webVitals: false,
  };
}

class BrowserAppAnalyticsClient implements AppAnalyticsClient {
  private autocaptureEventCount = 0;
  private autocaptureLimitReported = false;
  private config = defaultConfig();
  private deferredInit: AppAnalyticsOptions | undefined;
  private readonly delivery = new DeliveryPipeline((diagnostic) => {
    this.reportDiagnostic(diagnostic);
  });
  private lastPageLocation: string | undefined;
  private pendingCalls: PendingCall[] = [];
  private pendingCallsDropped = 0;
  private sampled: boolean | undefined;
  private sessionId: string | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private state: ClientState = "idle";

  private readonly pageViews = new Instrumentation(() => {
    const stop = observePageChanges(() => {
      this.recordPageViewIfLocationChanged();
    });
    if (stop === undefined) return undefined;
    return () => {
      stop();
      this.lastPageLocation = undefined;
    };
  });
  private readonly autocapture = new Instrumentation(() =>
    observeAutocapture(
      (signal) => this.recordAutocapture(signal),
      this.subscriberKeys.autocapture,
    ),
  );
  private readonly webVitals = new Instrumentation(() =>
    observeWebVitals(
      (metric, documentLocation) =>
        this.recordWebVital(metric, documentLocation),
      this.subscriberKeys.webVitals,
    ),
  );

  constructor(private readonly subscriberKeys: InstrumentationSubscriberKeys) {}

  init(options: AppAnalyticsOptions = {}): void {
    if (this.state === "stopping") {
      this.deferInit(options);
      return;
    }

    const previous = this.state;
    this.config = mergeConfig(this.config, options);
    this.state = "running";
    this.delivery.start();
    // Decide sampling for the current session now, with the rate in effect
    // when the client starts, not the rate of a later init() before the
    // first event.
    try {
      this.resolveSession(Date.now());
    } catch {
      // Sessions are resolved again, and contained, when events are recorded.
    }
    // Replay before automatic page views so a buffered page() for the current
    // path is not recorded twice.
    if (previous === "idle") this.replayPendingCalls();
    this.syncInstrumentation();
  }

  track(name: string, properties: EventProperties = {}): void {
    if (this.state === "running") {
      this.recordAction(name, properties);
    } else if (this.state === "idle") {
      this.bufferCall((call) => ({
        kind: "track",
        name,
        properties: { ...properties },
        call,
      }));
    }
  }

  page(properties: EventProperties = {}): void {
    if (this.state === "running") {
      this.recordPageView(properties);
    } else if (this.state === "idle") {
      this.bufferCall((call) => ({
        kind: "page",
        properties: { ...properties },
        call,
      }));
    }
  }

  async flush(): Promise<void> {
    await this.delivery.flush();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;

    this.pendingCalls = [];
    this.pendingCallsDropped = 0;
    if (this.state !== "running") {
      if (this.state === "idle") this.state = "stopped";
      return Promise.resolve();
    }

    this.state = "stopping";
    this.pageViews.disable();
    this.autocapture.disable();
    this.webVitals.disable();
    const operation = this.delivery.shutdown().finally(() => {
      this.config = defaultConfig();
      this.autocaptureEventCount = 0;
      this.autocaptureLimitReported = false;
      this.sampled = undefined;
      this.sessionId = undefined;
      this.shutdownPromise = undefined;
      this.state = "stopped";
    });
    this.shutdownPromise = operation;
    return operation;
  }

  private deferInit(options: AppAnalyticsOptions): void {
    const isFirstDeferral = this.deferredInit === undefined;
    this.deferredInit = { ...this.deferredInit, ...definedOptions(options) };
    if (!isFirstDeferral) return;

    void this.shutdownPromise?.then(() => {
      const deferred = this.deferredInit;
      this.deferredInit = undefined;
      if (deferred !== undefined && this.state === "stopped") {
        this.init(deferred);
      }
    });
  }

  private bufferCall(build: (call: CallContext) => PendingCall): void {
    if (this.pendingCalls.length >= MAX_PENDING_CALLS) {
      this.pendingCallsDropped += 1;
      return;
    }
    this.pendingCalls.push(
      build({ timestamp: Date.now(), path: readPageLocation().path }),
    );
  }

  private replayPendingCalls(): void {
    const calls = this.pendingCalls;
    const dropped = this.pendingCallsDropped;
    this.pendingCalls = [];
    this.pendingCallsDropped = 0;

    if (dropped > 0) {
      this.reportDiagnostic({ code: "queue_overflow", eventCount: dropped });
    }
    for (const pending of calls) {
      if (pending.kind === "track") {
        this.recordAction(pending.name, pending.properties, pending.call);
      } else {
        this.recordPageView(pending.properties, pending.call);
      }
    }
  }

  private recordAction(
    name: string,
    properties: EventProperties,
    call?: CallContext,
  ): boolean {
    return this.record(
      (metadata) =>
        createActionEvent(name, properties, metadata, this.reportDiagnostic),
      call,
    );
  }

  private recordPageView(
    properties: EventProperties,
    call?: CallContext,
  ): void {
    const path = call?.path ?? readPageLocation().path;
    this.record(
      (metadata) =>
        createPageViewEvent(properties, metadata, this.reportDiagnostic),
      call ?? { timestamp: Date.now(), path },
    );
    this.lastPageLocation = path;
  }

  private readonly recordWebVital = (
    metric: WebVitalMetric,
    documentLocation: { path: string },
  ): void => {
    this.record((metadata) =>
      createWebVitalEvent(metric, metadata, documentLocation),
    );
  };

  private recordAutocapture(signal: AutocaptureSignal): void {
    if (this.state !== "running") return;
    if (signal.kind === "ignored") {
      this.reportDiagnostic({
        code: "autocapture_ignored",
        eventCount: 1,
        reason: signal.reason,
      });
      return;
    }

    // Resolve first so a new session starts with a fresh allowance.
    this.resolveSession(Date.now());
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

    if (this.recordAction(signal.eventName, {})) {
      this.autocaptureEventCount += 1;
    }
  }

  /**
   * Builds, filters, and queues one event. Returns whether it was queued.
   *
   * A valid event extends the session whether or not the session is sampled
   * or the event is later dropped: session lifetime follows user activity,
   * and sampling only decides what is sent.
   */
  private record(
    createEvent: (metadata: BrowserEventMetadata) => BrowserEvent | null,
    call?: CallContext,
  ): boolean {
    if (this.state !== "running") return false;

    try {
      const now = Date.now();
      const session = this.resolveSession(now);
      const event = createEvent({
        id: createEventId(),
        timestamp: call?.timestamp ?? now,
        context: createEventContext(session.id, call?.path),
      });
      if (event === null) return false;

      markSessionActivity(session.id, now);
      if (!session.sampled) return false;

      const accepted = this.runBeforeSend(event);
      if (accepted === null) return false;
      return this.delivery.enqueue(this.resolvedEndpoint(), accepted);
    } catch {
      // Instrumentation must not change the behavior of the host application.
      this.reportDiagnostic({ code: "internal_error", eventCount: 1 });
      return false;
    }
  }

  private resolveSession(now: number): { id: string; sampled: boolean } {
    const sessionId = getOrCreateSessionId(now);
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.sampled = undefined;
      this.autocaptureEventCount = 0;
      this.autocaptureLimitReported = false;
    }
    this.sampled ??= isSessionSampled(sessionId, this.config.sampleRate);
    return { id: sessionId, sampled: this.sampled };
  }

  private runBeforeSend(event: BrowserEvent): BrowserEvent | null {
    const beforeSend = this.config.beforeSend;
    if (beforeSend === undefined) return event;

    try {
      const snapshot = createEventSnapshot(event);
      return applyBeforeSendResult(
        event,
        snapshot,
        beforeSend(snapshot),
        this.reportDiagnostic,
      );
    } catch {
      this.reportDiagnostic({ code: "before_send_error", eventCount: 1 });
      return null;
    }
  }

  private syncInstrumentation(): void {
    const { automaticPageViews, autocapture, webVitals } = this.config;
    if (automaticPageViews && typeof window !== "undefined") {
      // The initial page view must not depend on History API instrumentation.
      this.recordPageViewIfLocationChanged();
    }
    this.pageViews.set(automaticPageViews);
    this.autocapture.set(autocapture);
    this.webVitals.set(webVitals);
  }

  private recordPageViewIfLocationChanged(): void {
    if (readPageLocation().path === this.lastPageLocation) return;
    this.page();
  }

  private resolvedEndpoint(): string {
    this.config.endpoint ??= resolveDefaultEndpoint();
    return this.config.endpoint;
  }

  private readonly reportDiagnostic = (
    diagnostic: AppAnalyticsDiagnostic,
  ): void => {
    try {
      this.config.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and must not affect application code.
    }
  };
}

function mergeConfig(
  current: ClientConfig,
  options: AppAnalyticsOptions,
): ClientConfig {
  const next = { ...current };
  if (options.endpoint !== undefined) {
    next.endpoint = normalizeEndpoint(options.endpoint);
  }
  if (typeof options.beforeSend === "function") {
    next.beforeSend = options.beforeSend;
  }
  if (typeof options.onDiagnostic === "function") {
    next.onDiagnostic = options.onDiagnostic;
  }
  if (typeof options.sampleRate === "number") {
    next.sampleRate = normalizeSampleRate(options.sampleRate);
  }
  if (typeof options.automaticPageViews === "boolean") {
    next.automaticPageViews = options.automaticPageViews;
  }
  if (typeof options.autocapture === "boolean") {
    next.autocapture = options.autocapture;
  }
  if (typeof options.webVitals === "boolean") {
    next.webVitals = options.webVitals;
  }
  return next;
}

function definedOptions(options: AppAnalyticsOptions): AppAnalyticsOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as AppAnalyticsOptions;
}

function normalizeEndpoint(endpoint: unknown): string {
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

/** Creates an isolated client with its own configuration and queue. */
export function createAppAnalytics(): AppAnalyticsClient {
  const subscriberKey = {};
  return new BrowserAppAnalyticsClient({
    autocapture: subscriberKey,
    webVitals: subscriberKey,
  });
}

function isClient(value: unknown): value is AppAnalyticsClient {
  if (typeof value !== "object" || value === null) return false;
  const client = value as Partial<AppAnalyticsClient>;
  return (
    typeof client.init === "function" &&
    typeof client.track === "function" &&
    typeof client.page === "function" &&
    typeof client.flush === "function" &&
    typeof client.shutdown === "function"
  );
}

/**
 * The tab-wide client behind {@link appAnalytics}. It lives on `globalThis`,
 * so every copy of this package on the page (ESM and CJS builds, or a copy
 * bundled into another package) records through one queue and one set of
 * browser observers. It is created on first use.
 */
function defaultClient(): AppAnalyticsClient {
  return getOrCreateGlobal(
    DEFAULT_CLIENT_KEY,
    isClient,
    () =>
      new BrowserAppAnalyticsClient({
        autocapture: DEFAULT_AUTOCAPTURE_SUBSCRIBER_KEY,
        webVitals: DEFAULT_WEB_VITALS_SUBSCRIBER_KEY,
      }),
  );
}

/** The default client, shared by every copy of this package in the tab. */
export const appAnalytics: AppAnalyticsClient = {
  init: (options) => defaultClient().init(options),
  track: (name, properties) => defaultClient().track(name, properties),
  page: (properties) => defaultClient().page(properties),
  flush: () => defaultClient().flush(),
  shutdown: () => defaultClient().shutdown(),
};
