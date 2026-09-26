import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
  type MetricType,
} from "web-vitals";

import { readPageLocation, sanitizePageLocation } from "../core/context";
import type {
  EventContext,
  BrowserEvent,
  BrowserEventMetadata,
  WebVitalName,
  WebVitalNavigationType,
  WebVitalRating,
} from "../core/event";
import { MAX_STRING_VALUE_LENGTH } from "../core/properties";

const WEB_VITALS_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/web-vitals-state",
);

const WEB_VITAL_THRESHOLDS: Record<
  WebVitalName,
  { good: number; poor: number }
> = {
  cls: { good: 0.1, poor: 0.25 },
  fcp: { good: 1_800, poor: 3_000 },
  inp: { good: 200, poor: 500 },
  lcp: { good: 2_500, poor: 4_000 },
  ttfb: { good: 800, poor: 1_800 },
};

export interface WebVitalMetric {
  readonly name: MetricType["name"];
  readonly value: number;
  readonly delta: number;
  readonly id: string;
  readonly rating: MetricType["rating"];
  readonly navigationType: MetricType["navigationType"];
  readonly navigationURL?: string;
}

type PageLocation = Pick<EventContext, "path">;
type WebVitalListener = (
  metric: WebVitalMetric,
  documentLocation: PageLocation,
) => void;

interface WebVitalsState {
  observersRegistered: boolean;
  listeners: Map<unknown, WebVitalListener>;
  documentLocation?: PageLocation;
}

/**
 * Shares the page-lifetime observers installed by web-vitals across clients.
 * The upstream API has no disposer and must not be registered more than once.
 */
export function observeWebVitals(
  listener: WebVitalListener,
  subscriberKey: unknown = listener,
): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;

  const state = getWebVitalsState();
  state.documentLocation ??= readPageLocation();
  state.listeners.set(subscriberKey, listener);

  if (!state.observersRegistered) {
    state.observersRegistered = true;
    registerObservers(state);
  }

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    if (state.listeners.get(subscriberKey) === listener) {
      state.listeners.delete(subscriberKey);
    }
  };
}

export function createWebVitalEvent(
  metric: WebVitalMetric,
  metadata: BrowserEventMetadata,
  documentLocation: PageLocation = metadata.context,
): BrowserEvent | null {
  const name = normalizeWebVitalName(metric.name);
  if (
    name === undefined ||
    !isValidMetricNumber(metric.value) ||
    !isValidMetricNumber(metric.delta) ||
    !isBoundedString(metric.id)
  ) {
    return null;
  }

  return {
    id: metadata.id,
    name,
    type: "web_vital",
    timestamp: metadata.timestamp,
    properties: {},
    webVital: {
      value: metric.value,
      unit: name === "cls" ? "score" : "ms",
      delta: metric.delta,
      sampleId: metric.id,
      rating: rateWebVital(name, metric.value),
      navigationType: normalizeNavigationType(metric.navigationType),
    },
    context: contextForMetric(metric, metadata.context, documentLocation),
  };
}

function registerObservers(state: WebVitalsState): void {
  const report = (metric: MetricType) => notifyListeners(state, metric);
  const registrations = [
    () => onCLS(report),
    () => onFCP(report),
    () => onINP(report),
    () => onLCP(report),
    () => onTTFB(report),
  ];

  for (const register of registrations) {
    try {
      register();
    } catch {
      // A failed call may already have installed upstream listeners. Since
      // web-vitals has no disposer, retrying could create duplicate reports.
    }
  }
}

function notifyListeners(state: WebVitalsState, metric: WebVitalMetric): void {
  const documentLocation = state.documentLocation ?? readPageLocation();
  for (const listener of [...state.listeners.values()]) {
    try {
      listener(metric, documentLocation);
    } catch {
      // Performance instrumentation must not affect application behavior.
    }
  }
}

function contextForMetric(
  metric: WebVitalMetric,
  fallback: EventContext,
  documentLocation: PageLocation,
): EventContext {
  if (
    typeof metric.navigationURL !== "string" ||
    metric.navigationURL.length === 0
  ) {
    return { ...fallback, ...documentLocation };
  }

  try {
    const url = new URL(metric.navigationURL);
    const location = sanitizePageLocation({
      href: url.href,
      pathname: url.pathname,
    });
    return { ...fallback, ...location };
  } catch {
    return { ...fallback, ...documentLocation };
  }
}

function normalizeWebVitalName(
  name: WebVitalMetric["name"],
): WebVitalName | undefined {
  switch (name) {
    case "CLS":
      return "cls";
    case "FCP":
      return "fcp";
    case "INP":
      return "inp";
    case "LCP":
      return "lcp";
    case "TTFB":
      return "ttfb";
  }
}

function rateWebVital(name: WebVitalName, value: number): WebVitalRating {
  const thresholds = WEB_VITAL_THRESHOLDS[name];
  if (value <= thresholds.good) return "good";
  if (value <= thresholds.poor) return "needs_improvement";
  return "poor";
}

function normalizeNavigationType(
  value: WebVitalMetric["navigationType"],
): WebVitalNavigationType | undefined {
  switch (value) {
    case "navigate":
    case "reload":
    case "prerender":
    case "restore":
      return value;
    case "back-forward":
      return "back_forward";
    case "back-forward-cache":
      return "back_forward_cache";
    case "soft-navigation":
      return undefined;
  }
}

function isValidMetricNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRING_VALUE_LENGTH
  );
}

function getWebVitalsState(): WebVitalsState {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[WEB_VITALS_STATE_KEY];
  if (isWebVitalsState(existing)) return existing;

  const state: WebVitalsState = {
    observersRegistered: false,
    listeners: new Map(),
    documentLocation: readPageLocation(),
  };
  registry[WEB_VITALS_STATE_KEY] = state;
  return state;
}

function isWebVitalsState(value: unknown): value is WebVitalsState {
  if (typeof value !== "object" || value === null) return false;

  const state = value as Partial<WebVitalsState>;
  return (
    typeof state.observersRegistered === "boolean" &&
    state.listeners instanceof Map
  );
}
