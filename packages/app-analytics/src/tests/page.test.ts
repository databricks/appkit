import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppAnalytics, type AppAnalyticsClient } from "../index";
import {
  installFetchMock,
  readFirstLogRecord,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

const clients = new Set<AppAnalyticsClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.shutdown()));
  clients.clear();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("page views", () => {
  it("tracks the initial page and rolls back a partial hook installation", async () => {
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const replaceStateDescriptor = Object.getOwnPropertyDescriptor(
      window.history,
      "replaceState",
    );
    Object.defineProperty(window.history, "replaceState", {
      configurable: true,
      value: originalReplaceState,
      writable: false,
    });
    const fetchMock = installFetchMock();
    const client = createTestClient();

    try {
      client.init({ endpoint: "/analytics" });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const record = readFirstLogRecord(
        readPayload(fetchMock.mock.calls[0]?.[1]),
      );
      expect(record.eventName).toBe("page_view");
      expect(window.history.pushState).toBe(originalPushState);
      expect(window.history.replaceState).toBe(originalReplaceState);
    } finally {
      restoreOwnProperty(
        window.history,
        "replaceState",
        replaceStateDescriptor,
      );
    }

    client.init({ endpoint: "/analytics" });
    window.history.pushState({}, "", "/hooks-restored");
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await client.shutdown();
    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
  });

  it("tracks the initial page and History API navigation", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard?email=hidden%40example.com#access-token",
    );
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/analytics" });
    window.history.pushState({}, "", "/models/compare?token=hidden#details");
    window.history.replaceState({}, "", "/models/compare?tab=metrics");
    window.history.replaceState({}, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));

    expect(records.map(({ eventName }) => eventName)).toEqual([
      "page_view",
      "page_view",
      "page_view",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.event.type"),
      ),
    ).toEqual(["page_view", "page_view", "page_view"]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.page.path"),
      ),
    ).toEqual(["/dashboard", "/models/compare", "/settings"]);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("hidden%40example.com");
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("token=hidden");
    expect(serialized).not.toContain("tab=metrics");
  });

  it("keeps explicit page calls available for custom properties", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/analytics" });
    await client.flush();
    fetchMock.mockClear();

    client.page({
      control: "page_demo_event",
      page_view_count: 1,
      "databricks.app.analytics.event.type": "action",
      "url.full": "https://untrusted.example/private",
    });
    client.page({ control: "page_demo_event", page_view_count: 2 });
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records[0]?.attributes.map(({ key }) => key)).toEqual([
      "databricks.app.analytics.event.id",
      "databricks.app.analytics.schema.version",
      "databricks.app.analytics.event.type",
      "databricks.app.analytics.event.name",
      "databricks.app.analytics.session.id",
      "databricks.app.analytics.page.path",
      "databricks.app.analytics.properties.control",
      "databricks.app.analytics.properties.page_view_count",
    ]);
    expect(
      records.map((record) =>
        readStringAttribute(record, "databricks.app.analytics.event.type"),
      ),
    ).toEqual(["page_view", "page_view"]);
    expect(JSON.stringify(records)).not.toContain("untrusted.example");
  });

  it("allows automatic page views to be disabled", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    window.history.pushState({}, "", "/not-tracked-automatically");
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();

    client.page();
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops automatic and explicit page views on shutdown", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.page();
    client.init({ endpoint: "/analytics" });
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.shutdown();
    window.history.pushState({}, "", "/after-shutdown");
    client.page();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps shared History hooks until the last client shuts down", async () => {
    installFetchMock();
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const firstClient = createTestClient();
    const secondClient = createTestClient();

    firstClient.init({ endpoint: "/first-insights" });
    secondClient.init({ endpoint: "/second-insights" });
    const wrappedPushState = window.history.pushState;
    const wrappedReplaceState = window.history.replaceState;

    expect(wrappedPushState).not.toBe(originalPushState);
    expect(wrappedReplaceState).not.toBe(originalReplaceState);

    await firstClient.shutdown();
    expect(window.history.pushState).toBe(wrappedPushState);
    expect(window.history.replaceState).toBe(wrappedReplaceState);

    await secondClient.shutdown();
    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
  });

  it("shares one session with tracked actions", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/analytics" });
    client.track("demo_interaction");
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    const sessionIds = records.map((record) =>
      readStringAttribute(record, "databricks.app.analytics.session.id"),
    );
    const eventTypes = records.map((record) =>
      readStringAttribute(record, "databricks.app.analytics.event.type"),
    );

    expect(new Set(sessionIds).size).toBe(1);
    expect(eventTypes).toEqual(["page_view", "action"]);
  });

  it("contains automatic page-view failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    const client = createTestClient();

    expect(() => client.init({ endpoint: "/analytics" })).not.toThrow();
    expect(() => window.history.pushState({}, "", "/next-page")).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
  });
});

function createTestClient(): AppAnalyticsClient {
  const client = createAppAnalytics();
  clients.add(client);
  return client;
}

function restoreOwnProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
  } else {
    Object.defineProperty(target, property, descriptor);
  }
}
