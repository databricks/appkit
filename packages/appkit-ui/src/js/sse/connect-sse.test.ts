import { afterEach, describe, expect, test, vi } from "vitest";
import { connectSSE } from "./connect-sse";
import type { SSEMessage } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectSSE parser", () => {
  test("captures id, event, and data fields from each frame", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse([
          'id: 1\nevent: tick\ndata: {"value":1}\n\n',
          'id: 2\nevent: tick\ndata: {"value":2}\n\n',
        ]),
      ),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen).toEqual([
      { id: "1", event: "tick", data: '{"value":1}' },
      { id: "2", event: "tick", data: '{"value":2}' },
    ]);
  });

  test("ignores comment lines (`: hb`) without surfacing a message", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse([": heartbeat\n\n", 'event: tick\ndata: {"v":1}\n\n']),
      ),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe("tick");
  });

  test("preserves multi-line `data:` payloads joined by newline", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        sseResponse(["event: log\ndata: line one\ndata: line two\n\n"]),
      ),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen[0]?.data).toBe("line one\nline two");
  });

  test("emits empty `event` field when frame has no event line", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(sseResponse(['id: 7\ndata: {"x":1}\n\n'])),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen[0]).toEqual({ id: "7", event: "", data: '{"x":1}' });
  });

  test("reconnects on 502 by default and surfaces Last-Event-ID from latest frame", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(sseResponse(["id: 5\nevent: tick\ndata: ok\n\n"]));
    vi.stubGlobal("fetch", fetchSpy);

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      lastEventId: "5",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 1,
      // Production rejects retryDelay <= 0; use minimal delay for a fast retry.
      retryDelay: 1,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(retryInit?.headers).get("last-event-id")).toBe("5");
    expect(seen).toEqual([{ id: "5", event: "tick", data: "ok" }]);
  });

  test("abort signal cancels mid-stream and onMessage stops being called", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit | undefined) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode("event: first\ndata: one\n\n"));
          init?.signal?.addEventListener(
            "abort",
            () => {
              c.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });

    const seen: SSEMessage[] = [];
    const promise = connectSSE({
      url: "http://example.test/stream",
      signal: controller.signal,
      onMessage: async (m) => {
        seen.push(m);
        if (seen.length === 1) controller.abort();
      },
      maxRetries: 0,
    });

    await expect(promise).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: "", event: "first", data: "one" });
  });

  test("buffers a partial frame across chunk boundaries", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(sseResponse(['event: tick\ndata: {"x":', "1}\n\n"])),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen).toEqual([{ id: "", event: "tick", data: '{"x":1}' }]);
  });

  test("treats CRLF line endings the same as LF", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(sseResponse(["event: tick\r\ndata: payload\r\n\r\n"])),
    );

    const seen: SSEMessage[] = [];
    await connectSSE({
      url: "http://example.test/stream",
      onMessage: async (m) => {
        seen.push(m);
      },
      maxRetries: 0,
    });

    expect(seen).toEqual([{ id: "", event: "tick", data: "payload" }]);
  });

  test("stops after maxRetries on persistent failure", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchSpy);

    const promise = connectSSE({
      url: "http://example.test/stream",
      onMessage: async () => {},
      maxRetries: 2,
      retryDelay: 1,
    });

    await expect(promise).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
