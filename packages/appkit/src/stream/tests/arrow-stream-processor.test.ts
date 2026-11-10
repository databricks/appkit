import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ExecutionError } from "../../errors";
import { ArrowStreamProcessor } from "../arrow-stream-processor";

const EXTERNAL_LINK_DOWNLOAD_FAILED = "EXTERNAL_LINK_DOWNLOAD_FAILED";

/** A ReadableStream that emits the given pieces in order, then closes. */
function streamOf(...pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
}

function mockChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    chunkIndex: i,
    externalLink: `https://example.com/chunk-${i}`,
    rowOffset: BigInt(i * 100),
    rowCount: 100n,
  }));
}

/** Drain a byte generator to a flat number[]. */
async function drain(
  gen: AsyncGenerator<Uint8Array, void, unknown>,
): Promise<number[]> {
  const out: number[] = [];
  for await (const piece of gen) out.push(...piece);
  return out;
}

describe("ArrowStreamProcessor.streamChunks", () => {
  let processor: ArrowStreamProcessor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    processor = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    originalFetch = globalThis.fetch;
    // Default: each chunk's body is a single piece [100 + index].
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const match = String(input).match(/chunk-(\d+)/);
      const index = match ? Number.parseInt(match[1], 10) : 0;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: streamOf(new Uint8Array([100 + index])),
      } as unknown as Response;
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("throws when no chunks are provided", async () => {
    await expect(drain(processor.streamChunks([]))).rejects.toThrow();
  });

  test("streams chunks in array order", async () => {
    const bytes = await drain(processor.streamChunks(mockChunks(3)));
    expect(bytes).toEqual([100, 101, 102]);
  });

  test("pipes a chunk body piece-by-piece (no whole-chunk buffering)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])),
        }) as unknown as Response,
    );
    // Collect per-yield pieces (not flattened) to prove the body streams in
    // multiple reads rather than arriving as one buffer.
    const pieces: number[][] = [];
    for await (const piece of processor.streamChunks(mockChunks(1))) {
      pieces.push([...piece]);
    }
    expect(pieces).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  test("does not abort a healthy download when the consumer stalls between reads (backpressure)", async () => {
    // Body emits [1] immediately, then nothing until the test enqueues more.
    // It errors if the attempt's abort signal fires — mirroring a real fetch
    // being aborted. If the idle timer stayed armed across the downstream
    // `yield`, a slow consumer would trip it and kill this healthy stream.
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            bodyController = c;
            c.enqueue(new Uint8Array([1]));
          },
        });
        init?.signal?.addEventListener("abort", () =>
          bodyController.error(new Error("idle-aborted")),
        );
        return { ok: true, status: 200, body } as unknown as Response;
      },
    );

    const p = new ArrowStreamProcessor({ timeout: 50, retries: 1 });
    const gen = p.streamChunks(mockChunks(1));

    const first = await gen.next();
    expect([...(first.value as Uint8Array)]).toEqual([1]);

    // Consumer stalls well past the 50ms idle timeout while suspended at yield.
    await new Promise((r) => setTimeout(r, 120));

    // The download is still healthy — the rest streams through.
    bodyController.enqueue(new Uint8Array([2]));
    bodyController.close();

    const second = await gen.next();
    expect(second.done).toBe(false);
    expect([...(second.value as Uint8Array)]).toEqual([2]);
    expect((await gen.next()).done).toBe(true);
  });

  test("downloads lazily — one fetch per pulled chunk, not all upfront", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const iterator = processor.streamChunks(mockChunks(3));

    // Draining the first chunk's body fetches exactly one chunk.
    await iterator.next(); // first body piece of chunk 0
    await iterator.next(); // chunk 0 done → advances to chunk 1's fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries establishing the response, then streams the body", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamOf(new Uint8Array([7, 8, 9])),
      } as unknown as Response);
    globalThis.fetch = fetchMock;

    const bytes = await drain(processor.streamChunks(mockChunks(1)));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bytes).toEqual([7, 8, 9]);
  }, 10000);

  test("throws after exhausting retries on a non-2xx response", async () => {
    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 1 });
    globalThis.fetch = vi.fn(
      async () =>
        ({ ok: false, status: 500, statusText: "Server Error" }) as Response,
    );
    await expect(drain(p.streamChunks(mockChunks(1)))).rejects.toThrow(
      /chunk 0/,
    );
  });

  test("throws immediately when a chunk has no external_link", async () => {
    const chunks = [{ chunkIndex: 0 }] as any;
    await expect(drain(processor.streamChunks(chunks))).rejects.toThrow(
      /External link missing/,
    );
  });

  test("aborts during retry backoff instead of waiting it out", async () => {
    const controller = new AbortController();
    // Every attempt fails to connect, forcing the retry backoff between them.
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    globalThis.fetch = fetchMock;

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    const drained = drain(p.streamChunks(mockChunks(1), controller.signal));

    // Let the first attempt fail and enter the (~1s) backoff, then abort.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    await expect(drained).rejects.toThrow();
    // Aborting mid-backoff cancels immediately — no second fetch attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted signal cancels before fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    await expect(
      drain(processor.streamChunks(mockChunks(1), controller.signal)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("re-resolves an expired chunk link before retrying, then streams the fresh one", async () => {
    // First attempt hits an expired (403) link; the refresher mints a fresh
    // URL that the retry succeeds against.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamOf(new Uint8Array([42])),
      } as unknown as Response);
    globalThis.fetch = fetchMock;

    const refresh = vi.fn(async (chunkIndex: number) => ({
      chunkIndex,
      externalLink: "https://example.com/fresh-link",
    }));

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    const bytes = await drain(
      p.streamChunks(mockChunks(1), undefined, refresh),
    );

    expect(refresh).toHaveBeenCalledWith(0, undefined);
    // The retry fetched the fresh URL, not the stale one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://example.com/fresh-link",
    );
    expect(bytes).toEqual([42]);
  }, 10000);

  test("survives a refresher that throws — keeps retrying the current link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: streamOf(new Uint8Array([7])),
      } as unknown as Response);
    globalThis.fetch = fetchMock;

    const refresh = vi.fn(async () => {
      throw new Error("re-resolve failed");
    });

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    const bytes = await drain(
      p.streamChunks(mockChunks(1), undefined, refresh),
    );

    expect(refresh).toHaveBeenCalled();
    // Refresh failure is swallowed; the retry still runs against the original.
    expect(bytes).toEqual([7]);
  }, 10000);
});

const response = (status: number, statusText = "") =>
  new Response("denied", { status, statusText });
const okResponse = (...pieces: number[]) =>
  new Response(streamOf(new Uint8Array(pieces)));

async function failureOf(gen: AsyncGenerator<Uint8Array, void, unknown>) {
  try {
    await drain(gen);
  } catch (error) {
    if (error instanceof ExecutionError) return error;
    throw error;
  }
  throw new Error("expected the download to fail");
}

describe("ArrowStreamProcessor — refused downloads", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("sends the link's httpHeaders on every GET, and the new link's headers after a re-mint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(403, "Forbidden"))
      .mockResolvedValueOnce(okResponse(1));
    globalThis.fetch = fetchMock;
    const refresh = vi.fn(async (chunkIndex: number) => ({
      chunkIndex,
      externalLink: "https://example.com/fresh",
      httpHeaders: { "x-key": "fresh" },
    }));

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    await drain(
      p.streamChunks(
        [
          {
            chunkIndex: 0,
            externalLink: "https://example.com/stale",
            httpHeaders: { "x-key": "stale" },
          },
        ],
        undefined,
        refresh,
      ),
    );

    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { "x-key": "stale" },
      { "x-key": "fresh" },
    ]);
  });

  test.each([400, 404, 410])(
    "a %i is not retried, and the error carries the code and status",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(response(status, "No"));
      globalThis.fetch = fetchMock;
      const refresh = vi.fn();

      const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
      const error = await failureOf(
        p.streamChunks(mockChunks(1), undefined, refresh),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
      expect(error.context?.httpStatus).toBe(status);
    },
  );

  test("a 403 re-mints the link once, retries at once, then stops", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(403, "Forbidden"));
    globalThis.fetch = fetchMock;
    const refresh = vi.fn(async (chunkIndex: number) => ({
      chunkIndex,
      externalLink: "https://example.com/fresh",
    }));

    // retries: 1 proves the re-mint retry is not charged to the attempt budget.
    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 1 });
    const started = Date.now();
    const error = await failureOf(
      p.streamChunks(mockChunks(1), undefined, refresh),
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
    expect(error.context?.httpStatus).toBe(403);
  });

  test.each([429, 408])(
    "a %i is retried after the backoff and can succeed",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(status))
        .mockResolvedValueOnce(okResponse(5));
      globalThis.fetch = fetchMock;

      const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
      const bytes = await drain(p.streamChunks(mockChunks(1)));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bytes).toEqual([5]);
    },
    10000,
  );

  test("a 5xx keeps retrying and ends without a client-error status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(503, "Unavailable"));
    globalThis.fetch = fetchMock;

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 2 });
    const error = await failureOf(p.streamChunks(mockChunks(1)));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
    expect(error.context?.httpStatus).toBe(503);
  }, 10000);
});

describe("ArrowStreamProcessor — storage that stalls", () => {
  let server: Server;
  let gets = 0;
  let handler: Parameters<typeof createServer>[1];

  const link = () =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/chunk`;
  const chunks = () => [{ chunkIndex: 0, externalLink: link() }];

  beforeEach(async () => {
    gets = 0;
    server = createServer((req, res) => {
      gets++;
      handler?.(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  test("no response headers within responseTimeoutMs is a denial and is not retried", async () => {
    handler = () => {};

    const p = new ArrowStreamProcessor({
      timeout: 5000,
      retries: 3,
      responseTimeoutMs: 100,
    });
    const started = Date.now();
    const error = await failureOf(p.streamChunks(chunks()));

    expect(gets).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
    expect(error.context?.httpStatus).toBeUndefined();
  });

  test("the default wait for response headers is 10 seconds", () => {
    expect(ArrowStreamProcessor.DEFAULT_RESPONSE_TIMEOUT).toBe(10_000);
  });

  test("a healthy chunk that streams for longer than responseTimeoutMs finishes", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.from([sent++]));
        if (sent === 8) {
          clearInterval(timer);
          res.end();
        }
      }, 60);
    };

    const p = new ArrowStreamProcessor({
      timeout: 1000,
      retries: 1,
      responseTimeoutMs: 100,
    });
    const bytes = await drain(p.streamChunks(chunks()));

    expect(bytes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("a body that stalls after the headers fails with the download code", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": 1000 });
      res.flushHeaders();
    };

    const p = new ArrowStreamProcessor({
      timeout: 150,
      retries: 3,
      responseTimeoutMs: 100,
    });
    const error = await failureOf(p.streamChunks(chunks()));

    expect(gets).toBe(1);
    expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
  });

  test("a connection reset after the headers fails with the download code", async () => {
    handler = (req, res) => {
      res.writeHead(200, { "content-length": 1000 });
      res.flushHeaders();
      setTimeout(() => req.socket.destroy(), 30);
    };

    const p = new ArrowStreamProcessor({ timeout: 5000, retries: 3 });
    const error = await failureOf(p.streamChunks(chunks()));

    expect(error.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);
  });

  test("fullHeaderWait waits for headers as long as the attempt timeout", async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end(Buffer.from([9])), 300);
    };
    const p = new ArrowStreamProcessor({
      timeout: 2000,
      retries: 1,
      responseTimeoutMs: 100,
    });

    const strict = await failureOf(p.streamChunks(chunks()));
    expect(strict.errorCode).toBe(EXTERNAL_LINK_DOWNLOAD_FAILED);

    const bytes = await drain(
      p.streamChunks(chunks(), undefined, undefined, true),
    );
    expect(bytes).toEqual([9]);
  });

  test("an abort from the caller still reads as a cancellation", async () => {
    handler = () => {};
    const controller = new AbortController();
    const p = new ArrowStreamProcessor({
      timeout: 5000,
      retries: 3,
      responseTimeoutMs: 5000,
    });
    const failed = failureOf(p.streamChunks(chunks(), controller.signal));
    setTimeout(() => controller.abort(), 50);

    const error = await failed;
    expect(error.errorCode).toBeUndefined();
    expect(error.message).toMatch(/canceled/);
  });
});
