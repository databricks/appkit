import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserEvent } from "../core/event";
import { SDK_NAME, SDK_VERSION } from "../core/event";
import { encodeOtlp } from "../core/otlp-json";
import {
  MAX_BATCH_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  prepareBatch,
  REQUEST_TIMEOUT_MS,
  sendBatch,
  sendBatchOnUnload,
  type PreparedEventBatch,
} from "../core/transport";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transport batch preparation", () => {
  it("returns an empty result for an empty queue", () => {
    expect(prepareBatch([])).toEqual({ kind: "empty" });
  });

  it("takes no more than 25 events and preserves FIFO order", () => {
    const events = Array.from({ length: 30 }, (_, index) => createEvent(index));

    const prepared = prepareBatch(events);

    expect(prepared.kind).toBe("batch");
    if (prepared.kind !== "batch") return;
    expect(prepared.events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(prepared.events.map(({ id }) => id)).toEqual(
      events.slice(0, 25).map(({ id }) => id),
    );
  });

  it("takes the largest FIFO prefix below the encoded byte limit", () => {
    const events = Array.from({ length: 25 }, (_, index) =>
      createEvent(index, "x".repeat(2_400)),
    );

    const prepared = prepareBatch(events);

    expect(prepared.kind).toBe("batch");
    if (prepared.kind !== "batch") return;
    expect(prepared.events.length).toBeGreaterThan(1);
    expect(prepared.events.length).toBeLessThan(events.length);
    expect(prepared.byteLength).toBeLessThanOrEqual(MAX_BATCH_BODY_BYTES);

    const nextPrefix = events.slice(0, prepared.events.length + 1);
    expect(encodedByteLength(nextPrefix)).toBeGreaterThan(MAX_BATCH_BODY_BYTES);
    expect(prepared.events.map(({ id }) => id)).toEqual(
      events.slice(0, prepared.events.length).map(({ id }) => id),
    );
  });

  it("measures UTF-8 bytes rather than JavaScript string length", () => {
    // The property appears in both attributes and the readable JSON body.
    const event = createEvent(1, "é".repeat(MAX_BATCH_BODY_BYTES / 4));
    const body = JSON.stringify(encodeOtlp([event]));

    expect(body.length).toBeLessThan(MAX_BATCH_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(
      MAX_BATCH_BODY_BYTES,
    );

    const prepared = prepareBatch([event]);
    expect(prepared.kind).toBe("oversized");
    if (prepared.kind !== "oversized") return;
    expect(prepared.byteLength).toBe(new TextEncoder().encode(body).byteLength);
  });

  it("identifies an oversized event without truncating it", () => {
    const property = "x".repeat(MAX_BATCH_BODY_BYTES);
    const event = createEvent(1, property);

    const prepared = prepareBatch([event]);

    expect(prepared.kind).toBe("oversized");
    if (prepared.kind !== "oversized") return;
    expect(prepared.event).toBe(event);
    expect(prepared.event.properties.payload).toBe(property);
    expect(prepared.byteLength).toBeGreaterThan(MAX_BATCH_BODY_BYTES);
  });

  it("counts the readable body when an otherwise bounded attribute payload becomes oversized", () => {
    const event = createEvent(1);
    event.properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `field_${index}`,
        "x".repeat(1000),
      ]),
    );
    const payload = encodeOtlp([event]);
    const record = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    if (record === undefined) throw new Error("Expected one log record");
    expect(record.body).toBeDefined();
    const { body: _body, ...attributesOnly } = record;
    const withoutBody = {
      ...payload,
      resourceLogs: payload.resourceLogs.map((resource) => ({
        ...resource,
        scopeLogs: resource.scopeLogs.map((scope) => ({
          ...scope,
          logRecords: [attributesOnly],
        })),
      })),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(withoutBody)).byteLength,
    ).toBeLessThan(MAX_BATCH_BODY_BYTES);
    expect(encodedByteLength([event])).toBeGreaterThan(MAX_BATCH_BODY_BYTES);
    const prepared = prepareBatch([event]);
    expect(prepared.kind).toBe("oversized");
    if (prepared.kind !== "oversized") return;
    expect(prepared.event).toBe(event);
    expect(prepared.byteLength).toBe(encodedByteLength([event]));
    expect(Object.keys(event.properties)).toHaveLength(30);
  });

  it("identifies the first event when OTLP encoding fails", () => {
    const event = createEvent(1);
    event.timestamp = Number.NaN;

    expect(prepareBatch([event])).toEqual({
      kind: "encoding_error",
      event,
    });
  });
});

describe("transport delivery", () => {
  it("sends JSON with the constrained same-origin request policy", async () => {
    const batch = createPreparedBatch();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _request?: RequestInit) =>
        new Response(null, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendBatch("/analytics", batch)).resolves.toEqual({
      outcome: "accepted",
      status: 201,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe("/analytics");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: batch.body,
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      keepalive: false,
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes through the optional keepalive flag", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _request?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendBatch("/analytics", createPreparedBatch(), {
      keepalive: true,
    });

    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
  });

  it.each([200, 201, 202, 204, 299])(
    "classifies HTTP %i as accepted",
    async (status) => {
      installStatusResponse(status);

      await expect(
        sendBatch("/analytics", createPreparedBatch()),
      ).resolves.toEqual({ outcome: "accepted", status });
    },
  );

  it.each([408, 425, 429, 500, 503, 599])(
    "classifies HTTP %i as retryable",
    async (status) => {
      installStatusResponse(status);

      await expect(
        sendBatch("/analytics", createPreparedBatch()),
      ).resolves.toEqual({ outcome: "retryable", reason: "http", status });
    },
  );

  it.each([300, 400, 401, 403, 404, 413, 499])(
    "classifies HTTP %i as rejected",
    async (status) => {
      installStatusResponse(status);

      await expect(
        sendBatch("/analytics", createPreparedBatch()),
      ).resolves.toEqual({ outcome: "rejected", reason: "http", status });
    },
  );

  it("aborts and classifies requests that exceed ten seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, request?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = sendBatch("/analytics", createPreparedBatch());
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({
      outcome: "retryable",
      reason: "timeout",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["rejection", "synchronous throw"])(
    "classifies a network %s without throwing",
    async (failureMode) => {
      const failure = new TypeError("network unavailable");
      vi.stubGlobal(
        "fetch",
        failureMode === "rejection"
          ? vi.fn(() => Promise.reject(failure))
          : vi.fn(() => {
              throw failure;
            }),
      );

      await expect(
        sendBatch("/analytics", createPreparedBatch()),
      ).resolves.toEqual({ outcome: "retryable", reason: "network" });
    },
  );

  it("rejects delivery when fetch is unavailable", async () => {
    vi.stubGlobal("fetch", undefined);

    await expect(
      sendBatch("/analytics", createPreparedBatch()),
    ).resolves.toEqual({ outcome: "rejected", reason: "unavailable" });
  });
});

describe("unload delivery", () => {
  it("prefers fetch with keepalive and does not call Beacon", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _request?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const beaconMock = vi.fn(
      (_url: string | URL, _data?: BodyInit | null) => true,
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { sendBeacon: beaconMock });

    await expect(
      sendBatchOnUnload("/analytics", createPreparedBatch()),
    ).resolves.toEqual({ outcome: "accepted", status: 202 });

    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it("uses a JSON Blob with Beacon only when fetch is unavailable", async () => {
    const batch = createPreparedBatch();
    const beaconMock = vi.fn(
      (_url: string | URL, _data?: BodyInit | null) => true,
    );
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("navigator", { sendBeacon: beaconMock });

    await expect(sendBatchOnUnload("/analytics", batch)).resolves.toEqual({
      outcome: "accepted",
    });

    expect(beaconMock).toHaveBeenCalledOnce();
    const [endpoint, body] = beaconMock.mock.calls[0] ?? [];
    expect(endpoint).toBe("/analytics");
    if (!(body instanceof Blob)) throw new Error("Expected a Blob body");
    expect(body).toBeInstanceOf(Blob);
    expect(body.type).toBe("application/json");
    expect(body.size).toBe(batch.byteLength);
  });

  it.each(["returns false", "throws"])(
    "contains Beacon failure when it %s",
    async (failureMode) => {
      vi.stubGlobal("fetch", undefined);
      vi.stubGlobal("navigator", {
        sendBeacon:
          failureMode === "returns false"
            ? vi.fn(() => false)
            : vi.fn(() => {
                throw new Error("Beacon unavailable");
              }),
      });

      await expect(
        sendBatchOnUnload("/analytics", createPreparedBatch()),
      ).resolves.toEqual({ outcome: "rejected", reason: "unavailable" });
    },
  );

  it("does not fall back to Beacon after a fetch failure", async () => {
    const beaconMock = vi.fn(
      (_url: string | URL, _data?: BodyInit | null) => true,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    vi.stubGlobal("navigator", { sendBeacon: beaconMock });

    await expect(
      sendBatchOnUnload("/analytics", createPreparedBatch()),
    ).resolves.toEqual({ outcome: "retryable", reason: "network" });
    expect(beaconMock).not.toHaveBeenCalled();
  });
});

function createEvent(index: number, payload = "value"): BrowserEvent {
  return {
    id: `event-${index}`,
    name: "demo_interaction",
    type: "action",
    timestamp: 1_740_000_000_000 + index,
    properties: { payload },
    context: {
      sessionId: "session-1",
      path: "/dashboard",
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
    },
  };
}

function createPreparedBatch(): PreparedEventBatch {
  const prepared = prepareBatch([createEvent(1)]);
  if (prepared.kind !== "batch") {
    throw new Error(`Expected a prepared batch, received ${prepared.kind}`);
  }
  return prepared;
}

function encodedByteLength(events: readonly BrowserEvent[]): number {
  return new TextEncoder().encode(JSON.stringify(encodeOtlp(events)))
    .byteLength;
}

function installStatusResponse(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status })),
  );
}
