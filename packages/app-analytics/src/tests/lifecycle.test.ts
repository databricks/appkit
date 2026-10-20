import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_PENDING_CALLS } from "../client";
import { isSessionSampled } from "../core/sampling";
import {
  createAppAnalytics,
  type AppAnalyticsClient,
  type AppAnalyticsDiagnostic,
} from "../index";
import {
  installFetchMock,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

const clients = new Set<AppAnalyticsClient>();

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.shutdown()));
  clients.clear();
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sampling", () => {
  it("keeps an unsampled session while the user stays active", async () => {
    const { unsampled, sampled } = sessionIdsForRate(0.5);
    mockRandomUuids([unsampled, sampled]);
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ automaticPageViews: false, sampleRate: 0.5 });

    // One action every five minutes for forty minutes, well inside the
    // 30-minute inactivity timeout.
    for (let minute = 0; minute <= 40; minute += 5) {
      client.track("tick", { minute });
      vi.advanceTimersByTime(5 * 60_000);
    }
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collects autocapture after rotating from an unsampled session", async () => {
    const { unsampled, sampled } = sessionIdsForRate(0.5);
    mockRandomUuids([unsampled, sampled]);
    const fetchMock = installFetchMock();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const client = createTestClient();
    client.init({ automaticPageViews: false, sampleRate: 0.5 });

    vi.advanceTimersByTime(31 * 60_000);
    const button = document.createElement("button");
    button.dataset.appAnalyticsEvent = "export_clicked";
    document.body.append(button);
    invokeClickListener(addEventListener.mock.calls, button);
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "export_clicked",
    ]);
    expect(
      readStringAttribute(
        records[0] ?? fail(),
        "databricks.app.analytics.session.id",
      ),
    ).toBe(sampled);
  });

  it("decides sampling with the rate in effect when the client starts", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ automaticPageViews: false, sampleRate: 0 });
    client.init({ sampleRate: 1 });
    client.track("same_session");
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("init()", () => {
  it("merges options into the running configuration", async () => {
    const fetchMock = installFetchMock();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const client = createTestClient();

    client.init({ automaticPageViews: false, endpoint: "/first" });
    client.init({ sampleRate: 1 });
    client.track("after_second_init");
    await client.flush();

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/first"),
    ]);
    expect(countCalls(addEventListener.mock.calls, "click")).toBe(1);
    expect(countCalls(removeEventListener.mock.calls, "click")).toBe(0);

    client.init({ autocapture: false });
    expect(countCalls(removeEventListener.mock.calls, "click")).toBe(1);
  });

  it("restores defaults after shutdown", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ automaticPageViews: false, endpoint: "/first" });
    await client.shutdown();
    client.init({ automaticPageViews: false });
    client.track("after_restart");
    await client.flush();

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/_analytics/v1/logs"),
    ]);
  });

  it("restarts after an in-flight shutdown when called during it", async () => {
    let resolveFirstRequest: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const fetchMock = vi
      .fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 202 }),
      )
      .mockReturnValueOnce(firstResponse);
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();

    client.init({ automaticPageViews: false, endpoint: "/first" });
    client.track("before_shutdown");
    const shutdown = client.shutdown();
    client.init({ automaticPageViews: false, endpoint: "/second" });
    client.track("while_stopping");

    resolveFirstRequest?.(new Response(null, { status: 202 }));
    await shutdown;
    client.track("after_restart");
    await client.flush();

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/first"),
      absoluteEndpoint("/second"),
    ]);
    const names = readLogRecords(readPayload(fetchMock.mock.calls[1]?.[1])).map(
      ({ eventName }) => eventName,
    );
    expect(names).not.toContain("while_stopping");
    expect(names).toContain("after_restart");
  });
});

describe("calls before init()", () => {
  it("keeps the time and path of each call", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    window.history.replaceState({}, "", "/before");
    const calledAt = Date.now();
    client.track("early_action", { step: 1 });
    client.page({ section: "early" });
    vi.advanceTimersByTime(60_000);
    window.history.replaceState({}, "", "/after");

    client.init();
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(
      records.map((record) => [
        record.eventName,
        readStringAttribute(record, "databricks.app.analytics.page.path"),
      ]),
    ).toEqual([
      ["early_action", "/before"],
      ["page_view", "/before"],
      ["page_view", "/after"],
    ]);
    expect(records[0]?.timeUnixNano).toBe(
      (BigInt(calledAt) * 1_000_000n).toString(),
    );
  });

  it("does not record the initial page twice when page() ran first", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.page();
    client.init();
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual(["page_view"]);
  });

  it("keeps a bounded number of calls and reports the rest", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = installFetchMock();
    const client = createTestClient();

    for (let index = 0; index < MAX_PENDING_CALLS + 3; index += 1) {
      client.track("early_action");
    }
    client.init({
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await client.flush();

    const records = fetchMock.mock.calls.flatMap(([, request]) =>
      readLogRecords(readPayload(request)),
    );
    expect(records).toHaveLength(MAX_PENDING_CALLS);
    expect(diagnostics).toContainEqual({
      code: "queue_overflow",
      eventCount: 3,
    });
  });

  it("discards pending calls when shut down before init()", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.track("opted_out");
    await client.shutdown();
    client.init({ automaticPageViews: false });
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copies properties so later mutation does not change the event", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    const properties: Record<string, string> = { state: "initial" };

    client.track("early_action", properties);
    properties.state = "mutated";
    client.init({ automaticPageViews: false });
    await client.flush();

    const serialized = JSON.stringify(
      readPayload(fetchMock.mock.calls[0]?.[1]),
    );
    expect(serialized).toContain("initial");
    expect(serialized).not.toContain("mutated");
  });
});

describe("beforeSend", () => {
  it("can redact the path and properties and rename an Action", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    window.history.replaceState({}, "", "/users/42/orders/7");
    client.init({
      automaticPageViews: false,
      beforeSend: (event) => ({
        ...event,
        name: `app.${event.name}`,
        properties: { ...event.properties, customer: "[redacted]" },
        context: {
          ...event.context,
          path: event.context.path.replace(/\/\d+/g, "/:id"),
        },
      }),
    });

    client.track("order_opened", { customer: "acme" });
    client.page();
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(
      records.map((record) => [
        record.eventName,
        readStringAttribute(record, "databricks.app.analytics.page.path"),
      ]),
    ).toEqual([
      ["app.order_opened", "/users/:id/orders/:id"],
      ["page_view", "/users/:id/orders/:id"],
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("acme");
    expect(serialized).not.toContain("/42/");
  });

  it("validates returned values and drops the event on an invalid path", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = installFetchMock();
    const client = createTestClient();
    window.history.replaceState({}, "", "/users/42");
    client.init({
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      beforeSend: (event) =>
        event.name === "bad_path"
          ? {
              ...event,
              context: { ...event.context, path: 42 as unknown as string },
            }
          : { ...event, properties: { ...event.properties, userEmail: "x" } },
    });

    client.track("bad_path");
    client.track("adds_sensitive_key", { kept: true });
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "adds_sensitive_key",
    ]);
    expect(JSON.stringify(records)).not.toContain("userEmail");
    expect(diagnostics).toEqual([
      {
        code: "before_send_error",
        eventCount: 1,
        reason: "invalid_page_path",
      },
      {
        code: "property_dropped",
        eventCount: 1,
        propertyCount: 1,
        reason: "sensitive_name",
      },
    ]);
  });

  it("keeps SDK-owned fields and canonical names", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      automaticPageViews: false,
      beforeSend: (event) => ({
        ...event,
        id: "forged",
        type: "web_vital",
        name: event.type === "page_view" ? "renamed_page" : event.name,
        context: { ...event.context, sessionId: "forged" },
      }),
    });

    client.track("action");
    client.page();
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "action",
      "page_view",
    ]);
    expect(JSON.stringify(records)).not.toContain("forged");
  });
});

describe("delivery", () => {
  it("honors Retry-After before the retry", async () => {
    const fetchMock = vi
      .fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ automaticPageViews: false });

    client.track("rate_limited");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up the retry when Retry-After is too long", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 503, headers: { "Retry-After": "60" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("unavailable");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([
      {
        code: "delivery_failed",
        eventCount: 1,
        attempt: 1,
        reason: "http",
        status: 503,
      },
    ]);
  });
});

describe("contained failures", () => {
  it("reports an internal error instead of failing silently", () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const client = createTestClient();
    client.init({
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("private failure");
    });

    expect(() => client.track("any_event")).not.toThrow();
    expect(diagnostics).toEqual([{ code: "internal_error", eventCount: 1 }]);
  });
});

describe("session storage", () => {
  it("does not rewrite an unchanged session on every event", () => {
    installFetchMock();
    const client = createTestClient();
    client.init({ automaticPageViews: false });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    client.track("first");
    client.track("second");
    client.track("third");

    expect(setItem).not.toHaveBeenCalled();
  });
});

function createTestClient(): AppAnalyticsClient {
  const client = createAppAnalytics();
  clients.add(client);
  return client;
}

function sessionIdsForRate(rate: number): { unsampled: Uuid; sampled: Uuid } {
  let unsampled: Uuid | undefined;
  let sampled: Uuid | undefined;
  for (
    let index = 0;
    unsampled === undefined || sampled === undefined;
    index += 1
  ) {
    const id: Uuid = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
    if (isSessionSampled(id, rate)) sampled ??= id;
    else unsampled ??= id;
  }
  return { unsampled, sampled };
}

/** Session IDs come first; later IDs (event IDs) are unique and unchecked. */
function mockRandomUuids(sessionIds: Uuid[]): void {
  const queue = [...sessionIds];
  let fallback = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    const next = queue.shift();
    if (next !== undefined) return next;
    fallback += 1;
    return `ffffffff-0000-4000-8000-${fallback.toString().padStart(12, "0")}`;
  });
}

function invokeClickListener(
  calls: Array<[string, EventListenerOrEventListenerObject, unknown?]>,
  target: Element,
): void {
  const listener = calls.find(
    ([type, , options]) => type === "click" && options === true,
  )?.[1];
  if (typeof listener !== "function") {
    throw new Error("Expected one click autocapture listener");
  }
  listener({
    button: 0,
    isTrusted: true,
    target,
    type: "click",
  } as unknown as Event);
}

function countCalls(
  calls: Array<[string, EventListenerOrEventListenerObject, unknown?]>,
  type: string,
): number {
  return calls.filter(
    ([registeredType, , options]) =>
      registeredType === type && options === true,
  ).length;
}

function absoluteEndpoint(path: string): string {
  return new URL(path, window.location.href).href;
}

function fail(): never {
  throw new Error("Expected a record");
}
