import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricType } from "web-vitals";

interface ObserverMocks {
  callbacks: Map<MetricType["name"], (metric: MetricType) => void>;
  onCLS: ReturnType<typeof vi.fn>;
  onFCP: ReturnType<typeof vi.fn>;
  onINP: ReturnType<typeof vi.fn>;
  onLCP: ReturnType<typeof vi.fn>;
  onTTFB: ReturnType<typeof vi.fn>;
}

const observers = vi.hoisted<ObserverMocks>(() => ({
  callbacks: new Map(),
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

vi.mock("web-vitals", () => ({
  onCLS: observers.onCLS,
  onFCP: observers.onFCP,
  onINP: observers.onINP,
  onLCP: observers.onLCP,
  onTTFB: observers.onTTFB,
}));

import type { OtlpLogRecord } from "../core/otlp-json";
import {
  createAppAnalytics,
  appAnalytics,
  type AppAnalyticsClient,
  type AppAnalyticsEvent,
} from "../index";
import { AppAnalytics } from "../react";
import {
  installFetchMock,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

const WEB_VITALS_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/web-vitals-state",
);
const clients = new Set<AppAnalyticsClient>();

beforeEach(() => {
  Reflect.deleteProperty(globalThis, WEB_VITALS_STATE_KEY);
  observers.callbacks.clear();
  installObserver("CLS", observers.onCLS);
  installObserver("FCP", observers.onFCP);
  installObserver("INP", observers.onINP);
  installObserver("LCP", observers.onLCP);
  installObserver("TTFB", observers.onTTFB);
});

afterEach(async () => {
  cleanup();
  await appAnalytics.shutdown();
  await Promise.all([...clients].map((client) => client.shutdown()));
  clients.clear();
  Reflect.deleteProperty(globalThis, WEB_VITALS_STATE_KEY);
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Web Vitals", () => {
  it("maps all five metrics to bounded OTLP log records", async () => {
    window.history.replaceState({}, "", "/route-after-navigation");
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });

    const metrics = [
      createMetric("CLS", {
        value: 0.12,
        delta: 0.12,
        rating: "needs-improvement",
        navigationType: "back-forward",
      }),
      createMetric("FCP", {
        value: 1800,
        delta: 1800,
        navigationType: "back-forward-cache",
      }),
      createMetric("INP", {
        value: 320,
        delta: 320,
        rating: "needs-improvement",
      }),
      createMetric("LCP", {
        value: 3100,
        delta: 3100,
        rating: "poor",
      }),
      createMetric("TTFB", { value: 0, delta: 0 }),
    ];

    for (const metric of metrics) report(metric);
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records).toHaveLength(5);
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "cls",
      "fcp",
      "inp",
      "lcp",
      "ttfb",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.event.type"),
      ),
    ).toEqual(Array.from({ length: 5 }, () => "web_vital"));
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.event.name"),
      ),
    ).toEqual(["cls", "fcp", "inp", "lcp", "ttfb"]);

    records.forEach((record, index) => {
      const metric = metrics[index];
      if (metric === undefined) throw new Error("Expected matching metric");

      expect(
        readAttribute(record, "databricks.app.analytics.web_vital.value"),
      ).toEqual({
        doubleValue: metric.value,
      });
      expect(
        readAttribute(record, "databricks.app.analytics.web_vital.delta"),
      ).toEqual({
        doubleValue: metric.delta,
      });
      expect(
        readStringAttribute(
          record,
          "databricks.app.analytics.web_vital.sample_id",
        ),
      ).toBe(metric.id);
      expect(
        readStringAttribute(record, "databricks.app.analytics.page.path"),
      ).toBe("/orders/42");
    });

    expect(
      records.map((record) =>
        readStringAttribute(
          record,
          "databricks.app.analytics.web_vital.navigation_type",
        ),
      ),
    ).toEqual([
      "back_forward",
      "back_forward_cache",
      "navigate",
      "navigate",
      "navigate",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(
          record,
          "databricks.app.analytics.web_vital.rating",
        ),
      ),
    ).toEqual([
      "needs_improvement",
      "good",
      "needs_improvement",
      "needs_improvement",
      "good",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.web_vital.unit"),
      ),
    ).toEqual(["score", "ms", "ms", "ms", "ms"]);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("hidden@example.com");
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("entries");
    expect(serialized).not.toContain("navigationURL");
  });

  it("omits soft-navigation metadata that is not part of v1", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });

    report(createMetric("LCP", { navigationType: "soft-navigation" }));
    await client.flush();

    const record = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]))[0];
    if (record === undefined) throw new Error("Expected a Web Vital record");
    expect(
      record.attributes.some(
        ({ key }) =>
          key === "databricks.app.analytics.web_vital.navigation_type",
      ),
    ).toBe(false);
  });

  it("registers once, can be disabled, and reuses observers after shutdown", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    expectObserverRegistrations(0);

    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    expectObserverRegistrations(1);

    report(createMetric("LCP"));
    await client.flush();
    const firstSession = sessionIdForCall(fetchMock, 0);

    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: false,
    });
    report(createMetric("LCP", { id: "disabled-lcp" }));
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    expectObserverRegistrations(1);
    report(createMetric("LCP", { id: "enabled-again" }));
    await client.flush();
    expect(sessionIdForCall(fetchMock, 1)).toBe(firstSession);

    await client.shutdown();
    report(createMetric("LCP", { id: "after-shutdown" }));
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    expectObserverRegistrations(1);
    report(createMetric("LCP", { id: "after-reinit" }));
    await client.flush();
    expect(sessionIdForCall(fetchMock, 2)).toBe(firstSession);
  });

  it("does not duplicate observers across Strict Mode remounts", async () => {
    const fetchMock = installFetchMock();

    const firstView = render(
      <StrictMode>
        <AppAnalytics
          endpoint="/analytics"
          automaticPageViews={false}
          webVitals
        />
      </StrictMode>,
    );
    firstView.unmount();
    render(
      <AppAnalytics
        endpoint="/analytics"
        automaticPageViews={false}
        webVitals
      />,
    );

    expectObserverRegistrations(1);
    report(createMetric("TTFB"));
    await appAnalytics.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1])),
    ).toHaveLength(1);
  });

  it("keeps one public singleton subscriber after module re-evaluation", async () => {
    const fetchMock = installFetchMock();
    const firstClient = (await import("../client")).appAnalytics;
    firstClient.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    expectObserverRegistrations(1);

    vi.resetModules();
    const reloadedClient = (await import("../client")).appAnalytics;
    reloadedClient.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });
    expectObserverRegistrations(1);

    report(createMetric("FCP"));
    await Promise.all([firstClient.flush(), reloadedClient.flush()]);
    expect(fetchMock).toHaveBeenCalledOnce();

    // Both module copies drive the same shared client.
    await firstClient.shutdown();
    report(createMetric("LCP"));
    await reloadedClient.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves metric IDs while assigning an event ID to every report", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });

    report(createMetric("CLS", { id: "shared-metric", value: 0.1 }));
    report(
      createMetric("CLS", {
        id: "shared-metric",
        value: 0.15,
        delta: 0.05,
      }),
    );
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(
      records.map((record) =>
        readStringAttribute(
          record,
          "databricks.app.analytics.web_vital.sample_id",
        ),
      ),
    ).toEqual(["shared-metric", "shared-metric"]);
    expect(
      new Set(
        records.map((record) =>
          readStringAttribute(record, "databricks.app.analytics.event.id"),
        ),
      ).size,
    ).toBe(2);
  });

  it("shares sampling and beforeSend with other event types", async () => {
    const fetchMock = installFetchMock();
    const sampledOut = createTestClient();
    sampledOut.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 0,
      webVitals: true,
    });

    // Observers run in unsampled sessions too, so a later sampled session is
    // collected; the records themselves are dropped.
    expectObserverRegistrations(1);
    sampledOut.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 1,
      webVitals: true,
    });
    report(createMetric("LCP", { id: "sampled-out" }));
    await sampledOut.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    await sampledOut.shutdown();

    const snapshots: AppAnalyticsEvent[] = [];
    const filtered = createTestClient();
    filtered.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
      beforeSend: (event) => {
        snapshots.push(event);
        return event.type !== "web_vital";
      },
    });
    filtered.track("allowed_action");
    report(createMetric("INP"));
    await filtered.flush();

    expect(snapshots.map(({ type }) => type)).toEqual(["action", "web_vital"]);
    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "allowed_action",
    ]);
  });

  it("drops invalid metrics without leaking errors into the application", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });

    const invalidMetrics = [
      createMetric("LCP", { value: Number.NaN }),
      createMetric("INP", { delta: -1 }),
      createMetric("CLS", { id: "" }),
      { ...createMetric("FCP"), name: "FID" },
    ];
    const callback = observers.callbacks.get("LCP");
    if (callback === undefined) throw new Error("Expected LCP observer");

    for (const metric of invalidMetrics) {
      expect(() => callback(metric as MetricType)).not.toThrow();
    }
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps document context when a delayed metric has no navigation URL", async () => {
    window.history.replaceState({}, "", "/initial-document");
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
    });

    window.history.pushState({}, "", "/later-spa-route");
    report(createMetric("CLS", { navigationURL: undefined }));
    await client.flush();

    const record = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]))[0];
    if (record === undefined) throw new Error("Expected a Web Vital record");
    expect(
      readStringAttribute(record, "databricks.app.analytics.page.path"),
    ).toBe("/initial-document");
  });

  it("contains one observer registration failure and starts the others", async () => {
    observers.onCLS.mockImplementationOnce(() => {
      throw new Error("unsupported observer");
    });
    const fetchMock = installFetchMock();
    const client = createTestClient();

    expect(() =>
      client.init({
        endpoint: "/analytics",
        automaticPageViews: false,
        webVitals: true,
      }),
    ).not.toThrow();
    expectObserverRegistrations(1);
    expect(observers.callbacks.has("CLS")).toBe(false);

    report(createMetric("FCP"));
    await client.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fans out one browser metric to isolated clients", async () => {
    const fetchMock = installFetchMock();
    const first = createTestClient();
    const second = createTestClient();
    first.init({
      endpoint: "/first-insights",
      automaticPageViews: false,
      webVitals: true,
    });
    second.init({
      endpoint: "/second-insights",
      automaticPageViews: false,
      webVitals: true,
    });

    report(createMetric("LCP"));
    await Promise.all([first.flush(), second.flush()]);

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      new URL("/first-insights", window.location.href).href,
      new URL("/second-insights", window.location.href).href,
    ]);
    expect(sessionIdForCall(fetchMock, 0)).toBe(sessionIdForCall(fetchMock, 1));
  });
});

function installObserver(
  name: MetricType["name"],
  observer: ObserverMocks["onCLS"],
): void {
  observer.mockReset();
  observer.mockImplementation((callback: (metric: MetricType) => void) => {
    observers.callbacks.set(name, callback);
  });
}

function report(metric: MetricType): void {
  const callback = observers.callbacks.get(metric.name);
  if (callback === undefined) {
    throw new Error(`Expected ${metric.name} observer`);
  }
  callback(metric);
}

function createMetric(
  name: MetricType["name"],
  overrides: Partial<
    Pick<
      MetricType,
      "value" | "delta" | "id" | "rating" | "navigationType" | "navigationURL"
    >
  > = {},
): MetricType {
  return {
    name,
    value: 100,
    delta: 100,
    id: `metric-${name.toLowerCase()}`,
    rating: "good",
    navigationType: "navigate",
    navigationId: 1,
    navigationURL: `${window.location.origin}/orders/42?email=hidden@example.com#access-token`,
    entries: [],
    ...overrides,
  } as MetricType;
}

function expectObserverRegistrations(count: number): void {
  expect(observers.onCLS).toHaveBeenCalledTimes(count);
  expect(observers.onFCP).toHaveBeenCalledTimes(count);
  expect(observers.onINP).toHaveBeenCalledTimes(count);
  expect(observers.onLCP).toHaveBeenCalledTimes(count);
  expect(observers.onTTFB).toHaveBeenCalledTimes(count);
}

function createTestClient(): AppAnalyticsClient {
  const client = createAppAnalytics();
  clients.add(client);
  return client;
}

function readAttribute(record: OtlpLogRecord, key: string) {
  const attribute = record.attributes.find(
    (candidate) => candidate.key === key,
  );
  if (attribute === undefined) throw new Error(`Expected ${key} attribute`);
  return attribute.value;
}

function sessionIdForCall(
  fetchMock: ReturnType<typeof installFetchMock>,
  callIndex: number,
): string {
  const records = readLogRecords(
    readPayload(fetchMock.mock.calls[callIndex]?.[1]),
  );
  const record = records[0];
  if (record === undefined) throw new Error("Expected an OTLP log record");
  return readStringAttribute(record, "databricks.app.analytics.session.id");
}
