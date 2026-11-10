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
  /** Idle timeout (ms) for a single read, and the header wait of every chunk but a first that can still fall back. */
  timeout: number;
  /** Attempts to establish a chunk's response before any bytes are yielded. */
  retries: number;
  /** Longest wait (ms) for the first chunk's response headers before the download counts as denied. */
  responseTimeoutMs: number;
}

const EXTERNAL_LINK_DOWNLOAD_FAILED = "EXTERNAL_LINK_DOWNLOAD_FAILED";

const BACKOFF_MULTIPLIER = 1000;

type UsableLink = ExternalLink & { externalLink: string };

const hasUrl = (link: ExternalLink | undefined): link is UsableLink =>
  Boolean(link?.externalLink);

/** How storage refuses a presigned URL, including one that has expired. */
const isRefusalStatus = (status: unknown) => status === 400 || status === 403;

/** A 4xx won't change on retry, except a request timeout (408) or a rate limit (429). */
const isFinalStatus = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

interface DownloadFailure {
  status?: number;
  error: unknown;
  timedOut: boolean;
}

type Connection =
  | {
      ok: true;
      response: Response;
      controller: AbortController;
      detach: () => void;
    }
  | ({ ok: false } & DownloadFailure);

function downloadFailed(
  message: string,
  { status, error, timedOut }: DownloadFailure,
): ExecutionError {
  return new ExecutionError(message, {
    errorCode: EXTERNAL_LINK_DOWNLOAD_FAILED,
    context: { httpStatus: status, timedOut },
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * `err` as a chunk download failure: storage refused it (400/403), never
 * answered, or it failed some other way. `undefined` for any other error.
 */
export function asDownloadFailure(
  err: unknown,
):
  | { kind: "refused" | "unanswered" | "other"; error: ExecutionError }
  | undefined {
  if (
    !(err instanceof ExecutionError) ||
    err.errorCode !== EXTERNAL_LINK_DOWNLOAD_FAILED
  ) {
    return undefined;
  }
  const status = err.context?.httpStatus;
  const kind = isRefusalStatus(status)
    ? "refused"
    : err.context?.timedOut === true
      ? "unanswered"
      : "other";
  return { kind, error: err };
}

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
  static readonly DEFAULT_RESPONSE_TIMEOUT = 10000;

  private options: ArrowStreamOptions;

  constructor(options?: Partial<ArrowStreamOptions>) {
    this.options = {
      timeout: options?.timeout ?? ArrowStreamProcessor.DEFAULT_TIMEOUT,
      retries: options?.retries ?? ArrowStreamProcessor.DEFAULT_RETRIES,
      responseTimeoutMs:
        options?.responseTimeoutMs ??
        ArrowStreamProcessor.DEFAULT_RESPONSE_TIMEOUT,
    };
  }

  /**
   * Stream Arrow chunks in array order, piping each chunk's response body.
   *
   * Yields network-sized pieces as they arrive (not whole chunks), so peak
   * memory is one read buffer. Chunks are fetched sequentially; the
   * concatenation of everything yielded is byte-identical to the raw Arrow
   * result, so the client parses it exactly as a buffered response.
   *
   * Only the first chunk waits `responseTimeoutMs` for headers and stops on a
   * timeout, because only a failure before the first byte can still fall back.
   * `fullHeaderWait` gives it the full `timeout` too, for a second pass over a
   * download that only looked stalled.
   */
  async *streamChunks(
    chunks: ExternalLink[],
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
    fullHeaderWait = false,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    if (chunks.length === 0) {
      throw ValidationError.missingField("chunks");
    }

    const { timeout, responseTimeoutMs } = this.options;
    for (const [index, chunk] of chunks.entries()) {
      const first = index === 0;
      yield* this.streamChunkBody(
        chunk,
        signal,
        refresh,
        first && !fullHeaderWait
          ? Math.min(responseTimeoutMs, timeout)
          : timeout,
        first,
      );
    }
  }

  /**
   * Pipe one chunk's response body.
   *
   * Retry applies only while *establishing* the response (connection failure
   * or non-2xx) — once bytes have been yielded downstream we cannot re-fetch,
   * so a mid-body failure propagates and the caller aborts the response. An
   * idle timeout, reset before every read, aborts a stalled download.
   *
   * A 400 or 403 re-mints the link once, since a pre-signed URL may have expired. Other
   * 4xx (except 408/429) stop, and so does a header timeout when
   * `stopOnTimeout`: a blocked host hangs instead of refusing, so a retry only
   * repeats the wait.
   */
  private async *streamChunkBody(
    chunk: ExternalLink,
    signal: AbortSignal | undefined,
    refresh: RefreshChunkLink | undefined,
    headerWaitMs: number,
    stopOnTimeout: boolean,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    if (!hasUrl(chunk)) {
      // A missing link cannot be fixed by retrying — fail loudly.
      throw ExecutionError.statementFailed(
        `External link missing for chunk ${chunk.chunkIndex}`,
      );
    }
    let link: UsableLink = chunk;

    const { timeout, retries } = this.options;
    let connection: Extract<Connection, { ok: true }> | undefined;
    let failure: DownloadFailure = {
      error: new Error("no download attempts"),
      timedOut: false,
    };
    let attempts = 0;
    let reminted = false;

    while (attempts < retries) {
      if (signal?.aborted) throw ExecutionError.canceled();
      attempts++;
      const result = await this.connect(link, headerWaitMs, signal);
      if (result.ok) {
        connection = result;
        break;
      }
      failure = result;
      if (signal?.aborted) throw ExecutionError.canceled();
      if (result.timedOut && stopOnTimeout) break;

      const { status } = result;
      if (
        isRefusalStatus(status) &&
        refresh &&
        chunk.chunkIndex != null &&
        !reminted
      ) {
        reminted = true;
        attempts--;
        try {
          const fresh = await refresh(chunk.chunkIndex, signal);
          if (hasUrl(fresh)) link = fresh;
        } catch (refreshError) {
          logger.warn(
            "Failed to re-resolve link for chunk %s: %O",
            chunk.chunkIndex,
            refreshError,
          );
        }
        continue;
      }
      if (status !== undefined && isFinalStatus(status)) break;
      if (attempts < retries) {
        await this.delay(2 ** (attempts - 1) * BACKOFF_MULTIPLIER, signal);
      }
    }

    if (!connection) {
      const reason = failure.timedOut
        ? `no response within ${headerWaitMs}ms`
        : failure.error instanceof Error
          ? failure.error.message
          : String(failure.error);
      throw downloadFailed(
        `Failed to download chunk ${chunk.chunkIndex}: ${reason}`,
        failure,
      );
    }

    const { response, controller, detach } = connection;
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
          idleTimer = setTimeout(() => controller.abort(), timeout);
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
        : downloadFailed(
            `Failed streaming chunk ${chunk.chunkIndex}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { error, timedOut: false },
          );
    } finally {
      clearTimeout(idleTimer);
      detach();
    }
  }

  private async connect(
    link: UsableLink,
    headerWaitMs: number,
    signal?: AbortSignal,
  ): Promise<Connection> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const detach = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), headerWaitMs);
    try {
      const response = await fetch(link.externalLink, {
        signal: controller.signal,
        headers: link.httpHeaders,
      });
      clearTimeout(timer);
      if (response.ok) return { ok: true, response, controller, detach };
      await response.body?.cancel().catch(() => {});
      detach();
      return {
        ok: false,
        status: response.status,
        error: new Error(`${response.status} ${response.statusText}`),
        timedOut: false,
      };
    } catch (error) {
      clearTimeout(timer);
      detach();
      return {
        ok: false,
        error,
        timedOut: !signal?.aborted && controller.signal.aborted,
      };
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
