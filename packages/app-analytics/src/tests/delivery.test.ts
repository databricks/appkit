import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_QUEUE_SIZE } from "../core/queue";
import { FLUSH_INTERVAL_MS } from "../core/scheduler";
import { MAX_EVENTS_PER_BATCH } from "../core/transport";
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

describe("event delivery", () => {
  it("flushes at 25 events or after five seconds", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH - 1; index += 1) {
      client.track(`timer_event_${index}`);
    }

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readEventNames(fetchMock.mock.calls[0]?.[1])).toHaveLength(
      MAX_EVENTS_PER_BATCH - 1,
    );

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`threshold_event_${index}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readEventNames(fetchMock.mock.calls[1]?.[1])).toEqual(
      Array.from(
        { length: MAX_EVENTS_PER_BATCH },
        (_, index) => `threshold_event_${index}`,
      ),
    );
  });

  it("coalesces concurrent flushes without duplicating pending events", async () => {
    const pendingResponse = deferred<Response>();
    let requestCount = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        requestCount += 1;
        return requestCount === 1
          ? pendingResponse.promise
          : Promise.resolve(new Response(null, { status: 201 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("first_event");
    const firstFlush = client.flush();
    const secondFlush = client.flush();
    client.track("second_event");
    const thirdFlush = client.flush();

    let settled = false;
    void Promise.all([firstFlush, secondFlush, thirdFlush]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    const settledBeforeResponse = settled;
    const callsBeforeResponse = fetchMock.mock.calls.length;

    pendingResponse.resolve(new Response(null, { status: 201 }));
    await Promise.all([firstFlush, secondFlush, thirdFlush]);

    expect(settledBeforeResponse).toBe(false);
    expect(callsBeforeResponse).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readAllEventNames(fetchMock.mock.calls)).toEqual([
      "first_event",
      "second_event",
    ]);
  });

  it("resolves a flush at its event watermark", async () => {
    const firstResponse = deferred<Response>();
    const laterResponse = deferred<Response>();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(laterResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("inside_watermark");
    const firstFlush = client.flush();
    let firstFlushSettled = false;
    void firstFlush.then(() => {
      firstFlushSettled = true;
    });
    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`after_watermark_${index}`);
    }

    firstResponse.resolve(new Response(null, { status: 201 }));
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeLaterResponse = firstFlushSettled;
    const requestsBeforeLaterResponse = fetchMock.mock.calls.length;
    const firstRequest = fetchMock.mock.calls[0]?.[1];
    const laterRequest = fetchMock.mock.calls[1]?.[1];

    laterResponse.resolve(new Response(null, { status: 201 }));
    await firstFlush;
    await client.flush();

    expect(settledBeforeLaterResponse).toBe(true);
    expect(requestsBeforeLaterResponse).toBe(2);
    expect(readEventNames(firstRequest)).toEqual(["inside_watermark"]);
    expect(readEventNames(laterRequest)).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it("does not restart an expired timer after a watermark flush", async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("inside_watermark");
    const flush = client.flush();
    client.track("timer_expired_while_flushing");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    const requestsBeforeResponse = fetchMock.mock.calls.length;

    firstResponse.resolve(new Response(null, { status: 201 }));
    await flush;

    expect(requestsBeforeResponse).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readEventNames(fetchMock.mock.calls[1]?.[1])).toEqual([
      "timer_expired_while_flushing",
    ]);
  });

  it("retries a 500 once with the same event IDs", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("retry_event_1");
    client.track("retry_event_2");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readEventIds(fetchMock.mock.calls[0]?.[1])).toEqual(
      readEventIds(fetchMock.mock.calls[1]?.[1]),
    );
    expect(diagnostics).toEqual([
      {
        code: "delivery_retry",
        eventCount: 2,
        attempt: 1,
        reason: "http",
        status: 500,
      },
    ]);
  });

  it("keeps one retry budget across unload cycles", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("unload_retry_event");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readEventIds(fetchMock.mock.calls[0]?.[1])).toEqual(
      readEventIds(fetchMock.mock.calls[1]?.[1]),
    );
    expect(diagnostics).toEqual([
      {
        code: "delivery_retry",
        eventCount: 1,
        attempt: 1,
        reason: "http",
        status: 500,
      },
      {
        code: "delivery_failed",
        eventCount: 1,
        attempt: 2,
        reason: "http",
        status: 500,
      },
    ]);
  });

  it("counts an in-flight pagehide replay as the only retry", async () => {
    const firstResponse = deferred<Response>();
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("in_flight_retry_event");
    const flush = client.flush();
    window.dispatchEvent(new Event("pagehide"));
    const requestsAfterPageHide = fetchMock.mock.calls.length;

    firstResponse.resolve(new Response(null, { status: 500 }));
    await flush;

    expect(requestsAfterPageHide).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readEventIds(fetchMock.mock.calls[0]?.[1])).toEqual(
      readEventIds(fetchMock.mock.calls[1]?.[1]),
    );
    expect(diagnostics).toEqual([
      {
        code: "delivery_retry",
        eventCount: 1,
        attempt: 1,
        reason: "http",
        status: 500,
      },
      {
        code: "delivery_failed",
        eventCount: 1,
        attempt: 2,
        reason: "http",
        status: 500,
      },
    ]);
  });

  it("uses the pagehide replay as the retry while backoff is pending", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`backoff_event_${index}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    const requestsBeforePageHide = fetchMock.mock.calls.length;
    const diagnosticsBeforePageHide = [...diagnostics];

    window.dispatchEvent(new Event("pagehide"));
    const requestsAfterPageHide = fetchMock.mock.calls.length;
    const replayUsesKeepalive = fetchMock.mock.calls[1]?.[1]?.keepalive;
    const replayRequest = fetchMock.mock.calls[1]?.[1];
    const originalRequest = fetchMock.mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(500);
    await client.flush();

    expect(requestsBeforePageHide).toBe(1);
    expect(diagnosticsBeforePageHide).toEqual([
      {
        code: "delivery_retry",
        eventCount: MAX_EVENTS_PER_BATCH,
        attempt: 1,
        reason: "http",
        status: 500,
      },
    ]);
    expect(requestsAfterPageHide).toBe(2);
    expect(replayUsesKeepalive).toBe(true);
    expect(readEventIds(replayRequest)).toEqual(readEventIds(originalRequest));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveLength(1);
  });

  it("does not retry a rejected 400 response", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    client.track("rejected_event");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([
      {
        code: "delivery_failed",
        eventCount: 1,
        attempt: 1,
        reason: "http",
        status: 400,
      },
    ]);
  });

  it("bounds the queue while a request is pending", async () => {
    const pendingResponse = deferred<Response>();
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    let requestCount = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        requestCount += 1;
        return requestCount === 1
          ? pendingResponse.promise
          : Promise.resolve(new Response(null, { status: 201 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({
      endpoint: "/analytics",
      automaticPageViews: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`event_${index}`);
    }
    for (
      let index = MAX_EVENTS_PER_BATCH;
      index <= MAX_EVENTS_PER_BATCH + MAX_QUEUE_SIZE;
      index += 1
    ) {
      client.track(`event_${index}`);
    }

    const flush = client.flush();
    pendingResponse.resolve(new Response(null, { status: 201 }));
    await flush;

    expect(readAllEventNames(fetchMock.mock.calls)).toEqual(
      Array.from(
        { length: MAX_EVENTS_PER_BATCH + MAX_QUEUE_SIZE },
        (_, index) => `event_${index}`,
      ),
    );
    expect(diagnostics).toContainEqual({
      code: "queue_overflow",
      eventCount: 1,
    });
  });

  it("keeps the endpoint captured when each event was queued", async () => {
    const fetchMock = installFetchMock();
    const client = createTestClient();

    client.init({ endpoint: "/first", automaticPageViews: false });
    client.track("first_1");
    client.track("first_2");
    client.init({ endpoint: "/second", automaticPageViews: false });
    client.track("second_1");
    client.track("second_2");
    await client.flush();

    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      absoluteEndpoint("/first"),
      absoluteEndpoint("/second"),
    ]);
    expect(readEventNames(fetchMock.mock.calls[0]?.[1])).toEqual([
      "first_1",
      "first_2",
    ]);
    expect(readEventNames(fetchMock.mock.calls[1]?.[1])).toEqual([
      "second_1",
      "second_2",
    ]);
  });

  it("uses one keepalive request for coalesced hidden-page signals", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    client.track("pagehide_event");
    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[0]?.[1])).toEqual([
      "pagehide_event",
    ]);

    window.dispatchEvent(new Event("pageshow"));
    client.track("visibility_event");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[1]?.[1])).toEqual([
      "visibility_event",
    ]);
  });

  it("drains hidden shutdown batches sequentially in FIFO order", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const responses = Array.from({ length: 4 }, () => deferred<Response>());
    let nextResponse = 0;
    let requestsInFlight = 0;
    let maximumRequestsInFlight = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const response = responses[nextResponse];
        nextResponse += 1;
        requestsInFlight += 1;
        maximumRequestsInFlight = Math.max(
          maximumRequestsInFlight,
          requestsInFlight,
        );
        return (
          response?.promise ?? Promise.reject(new Error("No response"))
        ).finally(() => {
          requestsInFlight -= 1;
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    const eventNames = Array.from(
      { length: 60 },
      (_, index) => `hidden_shutdown_${index}`,
    );
    for (const eventName of eventNames) client.track(eventName);

    const requestsBeforeShutdown = fetchMock.mock.calls.length;
    const shutdown = client.shutdown();
    const requestProgression: number[] = [];
    for (const response of responses) {
      response.resolve(new Response(null, { status: 201 }));
      await vi.advanceTimersByTimeAsync(0);
      requestProgression.push(fetchMock.mock.calls.length);
    }
    await shutdown;

    expect(requestsBeforeShutdown).toBe(1);
    expect(requestProgression).toEqual([2, 3, 4, 4]);
    expect(maximumRequestsInFlight).toBe(1);
    expect(fetchMock.mock.calls.every(([, init]) => init?.keepalive)).toBe(
      true,
    );
    expect(readAllEventNames(fetchMock.mock.calls)).toEqual(eventNames);
  });

  it("makes an in-flight threshold batch safe for pagehide", async () => {
    const pendingResponse = deferred<Response>();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(pendingResponse.promise)
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`in_flight_${index}`);
    }
    client.track("queued_during_pagehide");
    window.dispatchEvent(new Event("pagehide"));
    const requestsAfterPageHide = fetchMock.mock.calls.length;
    const originalRequest = fetchMock.mock.calls[0]?.[1];
    const replayRequest = fetchMock.mock.calls[1]?.[1];

    pendingResponse.resolve(new Response(null, { status: 201 }));
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();

    expect(requestsAfterPageHide).toBe(2);
    expect(originalRequest?.keepalive).toBe(false);
    expect(replayRequest?.keepalive).toBe(true);
    expect(readEventIds(replayRequest)).toEqual(readEventIds(originalRequest));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[2]?.[1])).toEqual([
      "queued_during_pagehide",
    ]);
  });

  it("waits for an in-flight pagehide replay before advancing the queue", async () => {
    const originalResponse = deferred<Response>();
    const replayResponse = deferred<Response>();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(originalResponse.promise)
      .mockReturnValueOnce(replayResponse.promise)
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`in_flight_${index}`);
    }
    const flush = client.flush();
    client.track("waiting_behind_replay");
    window.dispatchEvent(new Event("pagehide"));
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });

    originalResponse.resolve(new Response(null, { status: 201 }));
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeReplay = flushSettled;
    const requestsBeforeReplay = fetchMock.mock.calls.length;

    replayResponse.resolve(new Response(null, { status: 201 }));
    await flush;
    await client.flush();

    expect(settledBeforeReplay).toBe(false);
    expect(requestsBeforeReplay).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[2]?.[1])).toEqual([
      "waiting_behind_replay",
    ]);
  });

  it("waits for an in-flight pagehide replay during shutdown", async () => {
    const originalResponse = deferred<Response>();
    const replayResponse = deferred<Response>();
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(originalResponse.promise)
      .mockReturnValueOnce(replayResponse.promise)
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    for (let index = 0; index < MAX_EVENTS_PER_BATCH; index += 1) {
      client.track(`shutdown_event_${index}`);
    }
    client.track("shutdown_tail_event");
    window.dispatchEvent(new Event("pagehide"));
    const shutdown = client.shutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });

    originalResponse.resolve(new Response(null, { status: 201 }));
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeReplay = shutdownSettled;

    replayResponse.resolve(new Response(null, { status: 201 }));
    await shutdown;

    expect(settledBeforeReplay).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readEventIds(fetchMock.mock.calls[1]?.[1])).toEqual(
      readEventIds(fetchMock.mock.calls[0]?.[1]),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[2]?.[1])).toEqual([
      "shutdown_tail_event",
    ]);
  });

  it("delivers events queued after the page becomes hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = installFetchMock();
    const client = createTestClient();
    client.init({ endpoint: "/analytics", automaticPageViews: false });

    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).not.toHaveBeenCalled();

    client.track("created_by_later_hidden_listener");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    expect(readEventNames(fetchMock.mock.calls[0]?.[1])).toEqual([
      "created_by_later_hidden_listener",
    ]);
  });
});

function createTestClient(): AppAnalyticsClient {
  const client = createAppAnalytics();
  clients.add(client);
  return client;
}

function readEventNames(request: RequestInit | undefined): string[] {
  return readLogRecords(readPayload(request)).map(({ eventName }) => eventName);
}

function readEventIds(request: RequestInit | undefined): string[] {
  return readLogRecords(readPayload(request)).map((record) =>
    readStringAttribute(record, "databricks.app.analytics.event.id"),
  );
}

function readAllEventNames(
  calls: Array<[RequestInfo | URL, RequestInit?]>,
): string[] {
  return calls.flatMap(([, request]) => readEventNames(request));
}

function absoluteEndpoint(path: string): string {
  return new URL(path, window.location.href).href;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
