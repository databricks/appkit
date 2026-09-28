import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppAnalyticsClient } from "../index";
import {
  installFetchMock,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

const observers = vi.hoisted(() => ({
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

vi.mock("web-vitals", () => observers);

const CLIENT_KEY = Symbol.for("@databricks/app-analytics/client-v1");
const CLIENT_CONFIGURED_KEY = Symbol.for(
  "@databricks/app-analytics/client-configured-v1",
);
const WEB_VITALS_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/web-vitals-state",
);

let fetchMock: ReturnType<typeof installFetchMock>;

beforeEach(() => {
  resetSharedState();
  fetchMock = installFetchMock();
});

afterEach(async () => {
  const client = Reflect.get(globalThis, CLIENT_KEY) as
    | AppAnalyticsClient
    | undefined;
  await client?.shutdown();
  resetSharedState();
  Reflect.deleteProperty(window, "__appkit__");
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("auto-start build", () => {
  it("starts the default client from the injected AppKit config", async () => {
    window.history.replaceState({}, "", "/orders");
    injectAppKitConfig({ webVitals: true });

    await loadAutoStart();
    const { appAnalytics } = await import("../index");
    await appAnalytics.flush();

    expect(sentEventNames()).toEqual(["page_view"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      new URL("/_analytics/v1/logs", window.location.href).href,
    );
    expect(observers.onLCP).toHaveBeenCalledOnce();
  });

  it("applies the injected sample rate", async () => {
    injectAppKitConfig({ sampleRate: 0 });

    await loadAutoStart();
    const { appAnalytics } = await import("../index");
    appAnalytics.track("report_exported");
    await appAnalytics.flush();

    expect(Reflect.get(globalThis, CLIENT_CONFIGURED_KEY)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores injected options it doesn't know or that have the wrong type", async () => {
    injectAppKitConfig({ endpoint: "/elsewhere", webVitals: "true" });

    await loadAutoStart();
    const { appAnalytics } = await import("../index");
    await appAnalytics.flush();

    expect(sentEventNames()).toEqual(["page_view"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      new URL("/_analytics/v1/logs", window.location.href).href,
    );
    expect(observers.onLCP).not.toHaveBeenCalled();
  });

  it("does nothing without the injected config", async () => {
    Reflect.set(window, "__appkit__", { appName: "app" });

    await loadAutoStart();
    const { appAnalytics } = await import("../index");
    appAnalytics.track("report_exported");
    await appAnalytics.flush();

    expect(Reflect.get(globalThis, CLIENT_CONFIGURED_KEY)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a client the app has already configured alone", async () => {
    injectAppKitConfig({ webVitals: true });
    const { appAnalytics } = await import("../index");
    appAnalytics.init({ automaticPageViews: false });

    await loadAutoStart();
    await appAnalytics.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(observers.onLCP).not.toHaveBeenCalled();
  });

  it("records one page view per navigation with <AppAnalytics /> also mounted", async () => {
    window.history.replaceState({}, "", "/orders");
    injectAppKitConfig({});

    await loadAutoStart();
    const { appAnalytics } = await import("../index");
    const { AppAnalytics } = await import("../react");
    const view = render(createElement(AppAnalytics, { webVitals: true }));
    window.history.pushState({}, "", "/orders/42");
    window.history.pushState({}, "", "/settings");
    await appAnalytics.flush();
    view.unmount();

    const records = sentRecords();
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "page_view",
      "page_view",
      "page_view",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.page.path"),
      ),
    ).toEqual(["/orders", "/orders/42", "/settings"]);
    // The component's options merged over the injected ones.
    expect(observers.onLCP).toHaveBeenCalledOnce();
  });
});

function injectAppKitConfig(appAnalytics: Record<string, unknown>): void {
  Reflect.set(window, "__appkit__", {
    appName: "app",
    queries: {},
    endpoints: {},
    plugins: {},
    appAnalytics,
  });
}

/** Evaluates a fresh copy of the auto-start entry, as loading sdk.js does. */
async function loadAutoStart(): Promise<void> {
  vi.resetModules();
  await import("../auto");
}

function sentRecords() {
  return fetchMock.mock.calls.flatMap(([, request]) =>
    readLogRecords(readPayload(request)),
  );
}

function sentEventNames(): Array<string | undefined> {
  return sentRecords().map(({ eventName }) => eventName);
}

function resetSharedState(): void {
  Reflect.deleteProperty(globalThis, CLIENT_KEY);
  Reflect.deleteProperty(globalThis, CLIENT_CONFIGURED_KEY);
  Reflect.deleteProperty(globalThis, WEB_VITALS_STATE_KEY);
}
