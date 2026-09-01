import { ExecutionError, ValidationError } from "../errors";
import { createLogger } from "../logging/logger";
import type { ExternalLink } from "../workspace-client";

const logger = createLogger("stream:arrow");

/**
 * Re-mint a chunk's pre-signed URL. DBSQL external links expire in <= 15 min,
 * so a large result whose tail chunks are reached after the earlier chunks
 * finish draining can hit an expired link; this fetches a fresh one for the
 * given chunk index. Created in the request's identity context (it captures the
 * caller's workspace client), so it stays valid even though streaming runs
 * outside that context. Returns `undefined` if the link can't be re-resolved.
 */
export type RefreshChunkLink = (
  chunkIndex: number,
  signal?: AbortSignal,
) => Promise<ExternalLink | undefined>;

interface ArrowStreamOptions {
  /** Idle timeout (ms) for a single chunk: no progress → abort the download. */
  timeout: number;
  /** Attempts to establish a chunk's response before any bytes are yielded. */
  retries: number;
}

const BACKOFF_MULTIPLIER = 1000;

/**
 * Streams Arrow IPC bytes for a completed statement's EXTERNAL_LINKS chunks
 * without ever buffering a whole chunk — each chunk's response body is piped
 * through as it arrives, so peak memory is a single network read rather than
 * a full chunk (let alone the full result). No Arrow parsing on the server;
 * the client parses the concatenated IPC bytes.
 */
export class ArrowStreamProcessor {
  static readonly DEFAULT_TIMEOUT = 30000;
  static readonly DEFAULT_RETRIES = 3;

  private options: ArrowStreamOptions;

  constructor(options?: Partial<ArrowStreamOptions>) {
    this.options = {
      timeout: options?.timeout ?? ArrowStreamProcessor.DEFAULT_TIMEOUT,
      retries: options?.retries ?? ArrowStreamProcessor.DEFAULT_RETRIES,
    };
  }

  /**
   * Stream Arrow chunks in array order, piping each chunk's response body.
   *
   * Yields network-sized pieces as they arrive (not whole chunks), so peak
   * memory is one read buffer. Chunks are fetched sequentially; the
   * concatenation of everything yielded is byte-identical to the raw Arrow
   * result, so the client parses it exactly as a buffered response.
   */
  async *streamChunks(
    chunks: ExternalLink[],
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    if (chunks.length === 0) {
      throw ValidationError.missingField("chunks");
    }

    for (const chunk of chunks) {
      yield* this.streamChunkBody(chunk, signal, refresh);
    }
  }

  /**
   * Pipe one chunk's response body.
   *
   * Retry applies only while *establishing* the response (connection failure
   * or non-2xx) — once bytes have been yielded downstream we cannot re-fetch,
   * so a mid-body failure propagates and the caller aborts the response. An
   * idle timeout, reset before every read, aborts a stalled download.
   */
  private async *streamChunkBody(
    chunk: ExternalLink,
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    let externalLink = chunk.externalLink;
    if (!externalLink) {
      // A missing link cannot be fixed by retrying — fail loudly.
      throw ExecutionError.statementFailed(
        `External link missing for chunk ${chunk.chunkIndex}`,
      );
    }

    let response: Response | undefined;
    let controller: AbortController | undefined;
    let onOuterAbort: (() => void) | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      if (signal?.aborted) throw ExecutionError.canceled();

      const attemptController = new AbortController();
      const listener = () => attemptController.abort();
      signal?.addEventListener("abort", listener, { once: true });
      const timer = setTimeout(
        () => attemptController.abort(),
        this.options.timeout,
      );

      try {
        const r = await fetch(externalLink, {
          signal: attemptController.signal,
        });
        clearTimeout(timer);
        if (!r.ok) {
          throw ExecutionError.statementFailed(
            `Failed to download chunk ${chunk.chunkIndex}: ${r.status} ${r.statusText}`,
          );
        }
        // Keep this attempt's controller alive to drive the body read + idle
        // timeout below.
        response = r;
        controller = attemptController;
        onOuterAbort = listener;
        break;
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", listener);
        lastError = error;
        if (signal?.aborted) throw ExecutionError.canceled();
        if (attempt < this.options.retries - 1) {
          await this.delay(2 ** attempt * BACKOFF_MULTIPLIER, signal);
          // Pre-signed URLs expire (<= 15 min). Before retrying, re-mint this
          // chunk's link — a stale URL would just 403 again on the same address.
          // Only meaningful before any bytes are yielded (below), which is why
          // this lives in the establish-response loop.
          if (refresh && chunk.chunkIndex != null) {
            try {
              const fresh = await refresh(chunk.chunkIndex, signal);
              if (fresh?.externalLink) externalLink = fresh.externalLink;
            } catch (refreshError) {
              // Keep retrying the current URL; surface the original error if
              // all attempts fail.
              logger.warn(
                "Failed to re-resolve link for chunk %s: %O",
                chunk.chunkIndex,
                refreshError,
              );
            }
          }
        }
      }
    }

    if (!response || !controller) {
      throw ExecutionError.statementFailed(
        `Failed to download chunk ${chunk.chunkIndex} after ${this.options.retries} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    }

    const body = response.body;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!body) return; // empty chunk (0 rows)
      const reader = body.getReader();
      try {
        while (true) {
          // The idle timeout must cover ONLY the upstream read, never the
          // downstream `yield`. Arm it right before `reader.read()` and clear
          // it the instant the read resolves — if it stayed armed across the
          // yield, a slow client backpressuring `writeChunk` would look like an
          // upstream stall and abort a perfectly healthy download.
          idleTimer = setTimeout(
            () => controller.abort(),
            this.options.timeout,
          );
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            ({ done, value } = await reader.read());
          } finally {
            clearTimeout(idleTimer);
          }
          if (done) break;
          if (value && value.byteLength > 0) yield value;
        }
      } finally {
        // Release the stream on early exit (downstream abort / error).
        reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (signal?.aborted) throw ExecutionError.canceled();
      logger.error(
        "Failed streaming chunk %s body: %O",
        chunk.chunkIndex,
        error,
      );
      throw error instanceof ExecutionError
        ? error
        : ExecutionError.statementFailed(
            `Failed streaming chunk ${chunk.chunkIndex}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
    } finally {
      clearTimeout(idleTimer);
      if (onOuterAbort) signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ExecutionError.canceled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
