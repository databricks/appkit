import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_INACTIVITY_TIMEOUT_MS } from "../core/context";
import {
  createAppAnalytics,
  type AppAnalyticsClient,
  type AppAnalyticsDiagnostic,
  type AppAnalyticsEvent,
} from "../index";
import {
  installFetchMock,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

const clients = new Set<AppAnalyticsClient>();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.shutdown()));
  clients.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client lifecycle", () => {
  it("makes shutdown idempotent and preserves the tab session on reinitialization", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/first", automaticPageViews: false });
    client.track("before_shutdown");
    const firstShutdown = client.shutdown();
    const secondShutdown = client.shutdown();

    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    client.track("while_stopped");

    client.init({ endpoint: "/second", automaticPageViews: false });
    client.track("after_reinit");
    await client.flush();

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/first"),
      absoluteEndpoint("/second"),
    ]);
    const firstRecord = readLogRecords(
      readPayload(fetchMock.mock.calls[0]?.[1]),
    )[0];
    const secondRecord = readLogRecords(
      readPayload(fetchMock.mock.calls[1]?.[1]),
    )[0];
    if (firstRecord === undefined || secondRecord === undefined) {
      throw new Error("Expected records before and after reinitialization");
    }
    expect(
      readStringAttribute(firstRecord, "databricks.app.analytics.session.id"),
    ).toBe(
      readStringAttribute(secondRecord, "databricks.app.analytics.session.id"),
    );
  });

  it("rotates the session after 30 minutes without an event", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("first_event");
    await client.flush();
    vi.advanceTimersByTime(SESSION_INACTIVITY_TIMEOUT_MS);
    client.track("after_inactivity");
    await client.flush();

    const sessionIds = fetchMock.mock.calls.map(([, request]) => {
      const record = readLogRecords(readPayload(request))[0];
      if (record === undefined) throw new Error("Expected a tracked event");
      return readStringAttribute(record, "databricks.app.analytics.session.id");
    });
    expect(sessionIds[1]).not.toBe(sessionIds[0]);
  });

  it("does not extend a session for an invalid event", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("first_event");
    await client.flush();
    vi.advanceTimersByTime(SESSION_INACTIVITY_TIMEOUT_MS - 1);
    client.track("invalid\nevent name");
    expect(diagnostics).toEqual([
      { code: "invalid_event_name", eventCount: 1 },
    ]);
    vi.advanceTimersByTime(1);
    client.track("after_inactivity");
    await client.flush();

    const sessionIds = fetchMock.mock.calls.map(([, request]) => {
      const record = readLogRecords(readPayload(request))[0];
      if (record === undefined) throw new Error("Expected a tracked event");
      return readStringAttribute(record, "databricks.app.analytics.session.id");
    });
    expect(sessionIds[1]).not.toBe(sessionIds[0]);
  });

  it("keeps one session when sessionStorage is readable but not writable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("first_event");
    client.track("second_event");
    await client.flush();

    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    const sessionIds = records.map((record) =>
      readStringAttribute(record, "databricks.app.analytics.session.id"),
    );
    expect(new Set(sessionIds).size).toBe(1);
  });

  it("samples at zero and one while preserving a decided session", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 0,
    });
    client.track("sampled_out");
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 1,
    });
    client.track("still_sampled_out");
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    await client.shutdown();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 1,
    });
    client.track("sampled_in");
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      sampleRate: 0,
    });
    client.track("still_sampled_in");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1])).map(
        ({ eventName }) => eventName,
      ),
    ).toEqual(["sampled_in", "still_sampled_in"]);
  });
});

describe("delivery hooks", () => {
  it("lets beforeSend veto events through a frozen snapshot", async () => {
    const snapshots: AppAnalyticsEvent[] = [];
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      beforeSend: (event) => {
        snapshots.push(event);
        return event.name === "blocked_event" ? false : undefined;
      },
    });

    client.track("blocked_event", { source: "private" });
    client.track("allowed_event", { source: "button" });
    await client.flush();

    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.context)).toBe(true);
      expect(Object.isFrozen(snapshot.properties)).toBe(true);
    }
    const allowedSnapshot = snapshots[1];
    if (allowedSnapshot === undefined) {
      throw new Error("Expected the allowed event snapshot");
    }
    expect(Reflect.set(allowedSnapshot, "name", "changed_event")).toBe(false);
    expect(Reflect.set(allowedSnapshot.properties, "source", "changed")).toBe(
      false,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const records = readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1]));
    expect(records.map(({ eventName }) => eventName)).toEqual([
      "allowed_event",
    ]);
    expect(JSON.stringify(records)).toContain("button");
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(records)).not.toContain("changed_event");
  });

  it("contains one beforeSend failure and continues tracking", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    let shouldThrow = true;
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      beforeSend: () => {
        if (!shouldThrow) return;
        shouldThrow = false;
        throw new Error("private hook failure");
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(() => client.track("failed_hook_event")).not.toThrow();
    client.track("event_after_hook_failure");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      readLogRecords(readPayload(fetchMock.mock.calls[0]?.[1])).map(
        ({ eventName }) => eventName,
      ),
    ).toEqual(["event_after_hook_failure"]);
    expect(diagnostics).toEqual([{ code: "before_send_error", eventCount: 1 }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private hook failure");
  });

  it("contains diagnostic hook failures without exposing event data", async () => {
    const observed: AppAnalyticsDiagnostic[] = [];
    const onDiagnostic = vi.fn((diagnostic: AppAnalyticsDiagnostic) => {
      observed.push(diagnostic);
      throw new Error("diagnostic observer failed");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 400 }),
      ),
    );
    const client = createTestClient();
    client.init({
      endpoint: "/analytics?token=private-token",
      automaticPageViews: false,
      onDiagnostic,
    });

    expect(() =>
      client.track("private_event_name", {
        email: "private@example.com",
      }),
    ).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();

    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([
      {
        code: "property_dropped",
        eventCount: 1,
        propertyCount: 1,
        reason: "sensitive_name",
      },
      {
        code: "delivery_failed",
        eventCount: 1,
        attempt: 1,
        reason: "http",
        status: 400,
      },
    ]);
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain("private_event_name");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("/analytics");
  });
});

function createTestClient(): AppAnalyticsClient {
  const client = createAppAnalytics();
  clients.add(client);
  return client;
}

function absoluteEndpoint(path: string): string {
  return new URL(path, window.location.href).href;
}
