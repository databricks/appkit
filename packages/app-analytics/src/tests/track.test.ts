import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_EVENT_NAME_LENGTH } from "../action";
import { DEFAULT_ENDPOINT } from "../client";
import { MAX_PAGE_PATH_BYTES, sanitizePageLocation } from "../core/context";
import {
  MAX_PROPERTY_COUNT,
  MAX_PROPERTY_NAME_LENGTH,
  MAX_STRING_VALUE_LENGTH,
  normalizeProperties,
} from "../core/properties";
import { createAppAnalytics, type EventProperties } from "../index";
import {
  installFetchMock,
  readFirstLogRecord,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("action tracking", () => {
  it("sends an identity-free OTLP event to the configured endpoint", async () => {
    window.history.replaceState(
      {},
      "",
      "/orders/42?email=hidden%40example.com#access-token",
    );
    const fetchMock = installFetchMock();
    const client = createAppAnalytics();

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    client.track("demo_interaction", {
      control: "track_demo_event",
      interaction_count: 1,
      enabled: true,
    });
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe(absoluteEndpoint("/analytics"));
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const payload = readPayload(request);
    const record = readFirstLogRecord(payload);
    const attributes = new Map(
      record.attributes.map(({ key, value }) => [key, value]),
    );

    expect(record.eventName).toBe("demo_interaction");
    expect(attributes.get("databricks.app.analytics.event.type")).toEqual({
      stringValue: "action",
    });
    expect(attributes.get("databricks.app.analytics.event.name")).toEqual({
      stringValue: "demo_interaction",
    });
    expect(attributes.get("databricks.app.analytics.page.path")).toEqual({
      stringValue: "/orders/42",
    });
    expect(
      attributes.get("databricks.app.analytics.properties.interaction_count"),
    ).toEqual({ intValue: "1" });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("hidden%40example.com");
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("distinctId");
    expect(serialized).not.toContain("user.");
  });

  it("omits invalid, nullish, and reserved properties", () => {
    const properties = {
      valid_string: "value",
      valid_number: 1.5,
      valid_boolean: false,
      omitted_null: null,
      omitted_undefined: undefined,
      not_finite: Number.POSITIVE_INFINITY,
      nested: { secret: "value" },
      "not valid": "hidden",
      UPPERCASE: "hidden",
      consecutive__delimiter: "hidden",
      "user.email": "hidden@example.com",
      email: "hidden@example.com",
      customer_email: "hidden@example.com",
      access_token: "hidden",
      authorization: "hidden",
      password: "hidden",
      ip_address: "127.0.0.1",
      user: "hidden",
      "User.Email": "hidden@example.com",
      " user.email": "hidden@example.com",
      "enduser.id": "hidden",
      "databricks.identity.subject": "hidden",
      "DATABRICKS.IDENTITY.subject": "hidden",
      "databricks.app.analytics.event.type": "web_vital",
      "databricks.app_analytics.action.source": "hidden",
      "databricks.app.analytics.event.name": "lcp",
      "BROWSER.WEB_VITAL.value": 1200,
      "databricks.web.interaction.type": "click",
      "DATABRICKS.WEB.INTERACTION.element": "button",
      "telemetry.sdk.name": "hidden",
      distinctId: "hidden",
      "databricks.app.analytics.event.id": "hidden",
      "url.full": "https://untrusted.example/private",
      "databricks.app.analytics.page.path": "/private",
      ["k".repeat(MAX_PROPERTY_NAME_LENGTH + 1)]: "too-long-key",
      too_long: "v".repeat(MAX_STRING_VALUE_LENGTH + 1),
    } as unknown as EventProperties;

    expect(normalizeProperties(properties)).toEqual({
      valid_string: "value",
      valid_number: 1.5,
      valid_boolean: false,
    });
  });

  it("bounds event names and the number of accepted properties", async () => {
    const fetchMock = installFetchMock();
    const client = createAppAnalytics();
    const properties = Object.fromEntries(
      Array.from({ length: MAX_PROPERTY_COUNT + 10 }, (_, index) => [
        `property_${index}`,
        index,
      ]),
    );

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    client.track("x".repeat(MAX_EVENT_NAME_LENGTH + 1), properties);
    client.track("invalid event name", properties);
    client.track(" padded_event ", properties);
    client.track("UPPERCASE", properties);
    client.track("browser.web_vital", properties);
    client.track("databricks.web.page_view", properties);
    client.track("session.started", properties);
    client.track("distinct_id", properties);
    expect(fetchMock).not.toHaveBeenCalled();

    client.track("bounded_event", properties);
    await client.flush();

    const payload = readPayload(fetchMock.mock.calls[0]?.[1]);
    const record = readFirstLogRecord(payload);
    const customAttributes = record.attributes.filter(({ key }) =>
      key.startsWith("databricks.app.analytics.properties."),
    );
    expect(customAttributes).toHaveLength(MAX_PROPERTY_COUNT);
  });

  it("does not send before initialization or after shutdown", async () => {
    const fetchMock = installFetchMock();
    const client = createAppAnalytics();

    client.track("before_init");
    client.init({ endpoint: "/analytics", automaticPageViews: false });
    await client.shutdown();
    client.track("after_shutdown");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains network failures and lets flush resolve", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new TypeError("network unavailable");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppAnalytics();

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    expect(() => client.track("demo_interaction")).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("waits for pending requests when flushed", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pendingResponse),
    );
    const client = createAppAnalytics();

    client.init({ endpoint: "/analytics", automaticPageViews: false });
    client.track("demo_interaction");

    let didFlush = false;
    const flush = client.flush().then(() => {
      didFlush = true;
    });
    await Promise.resolve();
    expect(didFlush).toBe(false);

    resolveRequest?.(new Response(null, { status: 202 }));
    await flush;
    expect(didFlush).toBe(true);
  });

  it("falls back to the default path for cross-origin endpoints", async () => {
    const fetchMock = installFetchMock();
    const client = createAppAnalytics();

    client.init({
      endpoint: "https://untrusted.example/collect",
      automaticPageViews: false,
    });
    client.track("demo_interaction");
    await client.flush();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      absoluteEndpoint(DEFAULT_ENDPOINT),
    );
  });

  it("falls back to the default path for endpoints with credentials", async () => {
    const fetchMock = installFetchMock();
    const endpoint = new URL("/analytics", window.location.href);
    endpoint.username = "browser-user";
    endpoint.password = "browser-secret";
    const client = createAppAnalytics();

    client.init({
      endpoint: endpoint.toString(),
      automaticPageViews: false,
    });
    client.track("demo_interaction");
    await client.flush();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      absoluteEndpoint(DEFAULT_ENDPOINT),
    );
  });

  it("does not throw when initialized in a document with an opaque URL", async () => {
    const fetchMock = installFetchMock();
    vi.stubGlobal("window", {
      location: { href: "about:blank", origin: "null" },
    });
    const client = createAppAnalytics();

    expect(() =>
      client.init({ endpoint: "/analytics", automaticPageViews: false }),
    ).not.toThrow();
    client.track("iframe_loaded");
    await client.flush();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(DEFAULT_ENDPOINT);
  });

  it("keeps relative endpoints stable across navigation and document bases", async () => {
    window.history.replaceState({}, "", "/app/start");
    const base = document.createElement("base");
    base.href = "https://untrusted.example/";
    document.head.append(base);
    const fetchMock = installFetchMock();
    const client = createAppAnalytics();

    try {
      client.init({ endpoint: "analytics", automaticPageViews: false });
      client.track("before_navigation");
      window.history.pushState(
        {},
        "",
        `${window.location.origin}/models/compare`,
      );
      client.track("after_navigation");
      await client.flush();

      expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
        `${window.location.origin}/app/analytics`,
      ]);
      expect(
        readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1])).map(
          ({ eventName }) => eventName,
        ),
      ).toEqual(["before_navigation", "after_navigation"]);
    } finally {
      base.remove();
    }
  });

  it("keeps only the sanitized page path", () => {
    expect(
      sanitizePageLocation({
        href: "https://user:secret@app.example/orders?email=hidden#token",
        pathname: "/orders",
      }),
    ).toEqual({ path: "/orders" });
  });

  it("omits page context that exceeds its UTF-8 byte limits", () => {
    const oversizedPath = `/${"é".repeat(MAX_PAGE_PATH_BYTES)}`;

    expect(
      sanitizePageLocation({
        href: `https://app.example${oversizedPath}`,
        pathname: oversizedPath,
      }),
    ).toEqual({ path: "" });

    const boundedPath = `/${"a".repeat(64)}`;
    const bounded = sanitizePageLocation({
      href: `https://app.example${boundedPath}`,
      pathname: boundedPath,
    });
    expect(new TextEncoder().encode(bounded.path).byteLength).toBeLessThan(
      MAX_PAGE_PATH_BYTES,
    );
  });

  it("shares one tab session across clients while keeping event IDs unique", async () => {
    const fetchMock = installFetchMock();
    const firstClient = createAppAnalytics();
    const secondClient = createAppAnalytics();

    firstClient.init({
      endpoint: "/first-insights",
      automaticPageViews: false,
    });
    secondClient.init({
      endpoint: "/second-insights",
      automaticPageViews: false,
    });
    firstClient.track("first_event");
    firstClient.track("second_event");
    secondClient.track("isolated_event");
    await Promise.all([firstClient.flush(), secondClient.flush()]);

    const calls = fetchMock.mock.calls;
    expect(calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/first-insights"),
      absoluteEndpoint("/second-insights"),
    ]);

    const records = calls.flatMap(([, request]) =>
      readLogRecords(readPayload(request)),
    );
    const sessionIds = records.map((record) =>
      readStringAttribute(record, "databricks.app.analytics.session.id"),
    );
    const eventIds = records.map((record) =>
      readStringAttribute(record, "databricks.app.analytics.event.id"),
    );

    expect(sessionIds[0]).toBe(sessionIds[1]);
    expect(sessionIds[2]).toBe(sessionIds[0]);
    expect(new Set(eventIds).size).toBe(3);
  });
});

function absoluteEndpoint(path: string): string {
  return new URL(path, window.location.href).href;
}
