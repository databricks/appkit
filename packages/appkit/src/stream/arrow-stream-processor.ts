import type { sql } from "@databricks/sdk-experimental";
import { ExecutionError, ValidationError } from "../errors";
import { createLogger } from "../logging/logger";

const logger = createLogger("stream:arrow");

type ExternalLink = sql.ExternalLink;

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
  ): AsyncGenerator<Uint8Array, void, unknown> {
    if (chunks.length === 0) {
      throw ValidationError.missingField("chunks");
    }

    for (const chunk of chunks) {
      yield* this.streamChunkBody(chunk, signal);
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
  ): AsyncGenerator<Uint8Array, void, unknown> {
    const externalLink = chunk.external_link;
    if (!externalLink) {
      // A missing link cannot be fixed by retrying — fail loudly.
      throw ExecutionError.statementFailed(
        `External link missing for chunk ${chunk.chunk_index}`,
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
            `Failed to download chunk ${chunk.chunk_index}: ${r.status} ${r.statusText}`,
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
        }
      }
    }

    if (!response || !controller) {
      throw ExecutionError.statementFailed(
        `Failed to download chunk ${chunk.chunk_index} after ${this.options.retries} attempts: ${
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
          // Reset the idle timeout before each read: a stalled body (no bytes
          // for `timeout` ms) aborts the download rather than hanging.
          clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => controller.abort(),
            this.options.timeout,
          );
          const { done, value } = await reader.read();
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
        chunk.chunk_index,
        error,
      );
      throw error instanceof ExecutionError
        ? error
        : ExecutionError.statementFailed(
            `Failed streaming chunk ${chunk.chunk_index}: ${
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
