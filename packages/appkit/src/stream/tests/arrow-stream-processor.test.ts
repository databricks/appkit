import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ArrowStreamProcessor } from "../arrow-stream-processor";

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
    chunk_index: i,
    external_link: `https://example.com/chunk-${i}`,
    row_offset: i * 100,
    row_count: 100,
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
    const chunks = [{ chunk_index: 0 }] as any;
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
});
