import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppAnalyticsClient } from "../index";
import { installFetchMock, readLogRecords, readPayload } from "./test-utils";

const CLIENT_KEY = Symbol.for("@databricks/app-analytics/client-v1");

beforeEach(() => {
  Reflect.deleteProperty(globalThis, CLIENT_KEY);
});

afterEach(async () => {
  const client = Reflect.get(globalThis, CLIENT_KEY) as
    | AppAnalyticsClient
    | undefined;
  await client?.shutdown();
  Reflect.deleteProperty(globalThis, CLIENT_KEY);
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("default client", () => {
  it("creates nothing when the package is imported", async () => {
    const fetchMock = installFetchMock();
    const pushState = window.history.pushState;

    vi.resetModules();
    const { appAnalytics } = await import("../index");
    await import("../react");

    expect(Reflect.has(globalThis, CLIENT_KEY)).toBe(false);
    expect(window.history.pushState).toBe(pushState);

    await appAnalytics.flush();

    expect(Reflect.has(globalThis, CLIENT_KEY)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares one client between two copies of the module", async () => {
    const fetchMock = installFetchMock();

    vi.resetModules();
    const first = await import("../index");
    vi.resetModules();
    const second = await import("../index");
    expect(second.appAnalytics).not.toBe(first.appAnalytics);

    first.appAnalytics.init({ endpoint: "/first", automaticPageViews: false });
    second.appAnalytics.track("shared_event");
    await second.appAnalytics.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      new URL("/first", window.location.href).href,
    );
    expect(
      readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1])).map(
        ({ eventName }) => eventName,
      ),
    ).toEqual(["shared_event"]);

    await second.appAnalytics.shutdown();
    first.appAnalytics.track("after_shutdown");
    await first.appAnalytics.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records one page view when both copies initialize", async () => {
    const fetchMock = installFetchMock();
    window.history.replaceState({}, "", "/orders");

    vi.resetModules();
    const first = await import("../index");
    vi.resetModules();
    const second = await import("../index");

    first.appAnalytics.init({ endpoint: "/analytics" });
    second.appAnalytics.init({ endpoint: "/analytics" });
    window.history.pushState({}, "", "/orders/42");
    await first.appAnalytics.flush();

    const records = fetchMock.mock.calls.flatMap(([, request]) =>
      readLogRecords(readPayload(request)),
    );
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "page_view",
      "page_view",
    ]);
  });
});
