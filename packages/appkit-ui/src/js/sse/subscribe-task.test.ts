import { afterEach, describe, expect, test, vi } from "vitest";
import {
  subscribeToTask,
  TASK_IDEMPOTENCY_HEADER,
} from "./subscribe-task";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface CountEvents {
  tick: { value: number; total: number };
  recovered: { resumed_from: number };
}

describe("subscribeToTask", () => {
  test("dispatches per-event handlers and surfaces idempotency key from header", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"ik-from-event"}\n\n',
            'id: 1\nevent: tick\ndata: {"value":1,"total":3}\n\n',
            'id: 2\nevent: tick\ndata: {"value":2,"total":3}\n\n',
            'id: 3\nevent: completed\ndata: {"final":3}\n\n',
          ],
          headers: { [TASK_IDEMPOTENCY_HEADER]: "ik-from-header" },
        }),
      ),
    );

    const ticks: CountEvents["tick"][] = [];
    let readyIK: string | null = null;
    let completed: { final: number } | null = null;

    const result = await subscribeToTask<
      CountEvents,
      { final: number }
    >({
      url: "/run",
      payload: { n: 3 },
      onReady: ({ idempotencyKey }) => {
        readyIK = idempotencyKey;
      },
      onEvent: {
        tick: (p) => {
          ticks.push(p);
        },
      },
      onCompleted: (r) => {
        completed = r;
      },
    });

    expect(readyIK).toBe("ik-from-header");
    expect(result.idempotencyKey).toBe("ik-from-header");
    expect(ticks).toEqual([
      { value: 1, total: 3 },
      { value: 2, total: 3 },
    ]);
    expect(completed).toEqual({ final: 3 });
  });

  test("falls back to `ready` event payload when no IK header is set", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"ik-from-event"}\n\n',
            "event: completed\ndata: null\n\n",
          ],
        }),
      ),
    );

    let readyIK: string | null = null;
    const result = await subscribeToTask({
      url: "/run",
      onReady: ({ idempotencyKey }) => {
        readyIK = idempotencyKey;
      },
    });

    expect(readyIK).toBe("ik-from-event");
    expect(result.idempotencyKey).toBe("ik-from-event");
  });

  test("calls onFailed and stops on a `failed` terminal event", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"x"}\n\n',
            'event: failed\ndata: {"message":"boom"}\n\n',
            // Anything after a terminal event must be ignored.
            'event: tick\ndata: {"value":99,"total":1}\n\n',
          ],
        }),
      ),
    );

    const ticks: number[] = [];
    let failedMessage: string | null = null;
    await subscribeToTask<CountEvents>({
      url: "/run",
      onEvent: {
        tick: (p) => {
          ticks.push(p.value);
        },
      },
      onFailed: (m) => {
        failedMessage = m;
      },
    });

    expect(failedMessage).toBe("boom");
    expect(ticks).toEqual([]);
  });

  test("calls onCancelled on a `cancelled` terminal event", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"x"}\n\n',
            'event: cancelled\ndata: {"reason":"user_requested"}\n\n',
          ],
        }),
      ),
    );

    let cancelled = false;
    await subscribeToTask({
      url: "/run",
      onCancelled: () => {
        cancelled = true;
      },
    });

    expect(cancelled).toBe(true);
  });

  test("silently drops events the consumer didn't subscribe to", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"x"}\n\n',
            'event: tick\ndata: {"value":1,"total":1}\n\n',
            'event: recovered\ndata: {"resumed_from":0}\n\n',
            "event: completed\ndata: null\n\n",
          ],
        }),
      ),
    );

    const ticks: number[] = [];
    await subscribeToTask<CountEvents>({
      url: "/run",
      onEvent: {
        tick: (p) => {
          ticks.push(p.value);
        },
      },
    });

    expect(ticks).toEqual([1]);
  });

  test("ignores comment-only frames (heartbeats)", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            ": heartbeat\n\n",
            'event: ready\ndata: {"idempotencyKey":"x"}\n\n',
            ": heartbeat\n\n",
            'event: tick\ndata: {"value":1,"total":1}\n\n',
            "event: completed\ndata: null\n\n",
          ],
        }),
      ),
    );

    const ticks: number[] = [];
    await subscribeToTask<CountEvents>({
      url: "/run",
      onEvent: {
        tick: (p) => {
          ticks.push(p.value);
        },
      },
    });

    expect(ticks).toEqual([1]);
  });

  test("does not call onError when the abort signal fires", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit | undefined) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(
            enc.encode('event: ready\ndata: {"idempotencyKey":"x"}\n\n'),
          );
          // Never close; the consumer aborts.
          init?.signal?.addEventListener("abort", () => {
            c.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });

    const errors: unknown[] = [];
    const promise = subscribeToTask({
      url: "/run",
      signal: controller.signal,
      onError: (e) => {
        errors.push(e);
      },
    });

    // Give the stream loop a tick to enter `reader.read()`, then abort.
    await Promise.resolve();
    controller.abort();

    const result = await promise;
    expect(errors).toEqual([]);
    expect(result.idempotencyKey).toBe("x");
  });

  test("calls onError on non-2xx HTTP status", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );

    const errors: unknown[] = [];
    await subscribeToTask({
      url: "/run",
      onError: (e) => {
        errors.push(e);
      },
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("HTTP 500");
  });

  test("issues GET when no payload is provided (reattach pattern)", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse({
          chunks: ["event: completed\ndata: null\n\n"],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await subscribeToTask({ url: "/reattach/abc" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  test("forwards `lastEventId` as Last-Event-ID header", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse({ chunks: ["event: completed\ndata: null\n\n"] }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await subscribeToTask({
      url: "/reattach/abc",
      lastEventId: "42",
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("42");
  });

  test('treats engine "completed" frame as terminal and resolves with payload', async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"ik"}\n\n',
            'event: completed\ndata: {"result":42}\n\n',
          ],
        }),
      ),
    );

    let result: { result: number } | null = null;
    const promise = subscribeToTask<CountEvents, { result: number }>({
      url: "/run",
      onCompleted: (r) => {
        result = r;
      },
    });

    await expect(promise).resolves.toMatchObject({ idempotencyKey: "ik" });
    expect(result).toEqual({ result: 42 });
  });

  test('treats engine "failed" frame as terminal and rejects with the error', async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"ik"}\n\n',
            'event: failed\ndata: {"message":"boom"}\n\n',
          ],
        }),
      ),
    );

    let failedMessage: string | null = null;
    const promise = subscribeToTask({
      url: "/run",
      onFailed: (m) => {
        failedMessage = m;
      },
    });

    await expect(promise).resolves.toMatchObject({ idempotencyKey: "ik" });
    expect(failedMessage).toBe("boom");
  });

  test('forwards "cancelled" terminal correctly', async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"ik"}\n\n',
            "event: cancelled\ndata: {}\n\n",
          ],
        }),
      ),
    );

    let cancelled = false;
    const promise = subscribeToTask({
      url: "/run",
      onCancelled: () => {
        cancelled = true;
      },
    });

    await expect(promise).resolves.toMatchObject({ idempotencyKey: "ik" });
    expect(cancelled).toBe(true);
  });

  test("drops `event: heartbeat` frames silently", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse({
          chunks: [
            'event: ready\ndata: {"idempotencyKey":"x"}\n\n',
            "event: heartbeat\ndata: {}\n\n",
            'event: tick\ndata: {"value":7,"total":10}\n\n',
            "event: completed\ndata: null\n\n",
          ],
        }),
      ),
    );

    const custom: number[] = [];
    await subscribeToTask<CountEvents>({
      url: "/run",
      onEvent: {
        tick: (p) => {
          custom.push(p.value);
        },
      },
    });

    expect(custom).toEqual([7]);
  });
});

interface SseResponseInit {
  chunks: string[];
  headers?: Record<string, string>;
}

function sseResponse({ chunks, headers }: SseResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}
