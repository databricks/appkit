import type { sql } from "@databricks/sdk-experimental";
import { ExecutionError, ValidationError } from "../observability/errors";

type ResultManifest = sql.ResultManifest;
type ExternalLink = sql.ExternalLink;

export interface ArrowStreamOptions {
  maxConcurrentDownloads: number;
  timeout: number;
  retries: number;
}

/**
 * Result from zero-copy Arrow chunk processing.
 * Contains raw IPC bytes without server-side parsing.
 */
export interface ArrowRawResult {
  /** Concatenated raw Arrow IPC bytes */
  data: Uint8Array;
  /** Schema from Databricks manifest (not parsed from Arrow) */
  schema: ResultManifest["schema"];
}

const BACKOFF_MULTIPLIER = 1000;

export class ArrowStreamProcessor {
  static readonly DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;
  static readonly DEFAULT_TIMEOUT = 30000;
  static readonly DEFAULT_RETRIES = 3;

  constructor(
    private options: ArrowStreamOptions = {
      maxConcurrentDownloads:
        ArrowStreamProcessor.DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      timeout: ArrowStreamProcessor.DEFAULT_TIMEOUT,
      retries: ArrowStreamProcessor.DEFAULT_RETRIES,
    },
  ) {
    this.options = {
      maxConcurrentDownloads:
        options.maxConcurrentDownloads ??
        ArrowStreamProcessor.DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      timeout: options.timeout ?? ArrowStreamProcessor.DEFAULT_TIMEOUT,
      retries: options.retries ?? ArrowStreamProcessor.DEFAULT_RETRIES,
    };
  }

  /**
   * Process Arrow chunks using zero-copy proxy pattern.
   *
   * Downloads raw IPC bytes from external links and concatenates them
   * without parsing into Arrow Tables on the server. This reduces:
   * - Memory usage by ~50% (no parsed Table representation)
   * - CPU usage (no tableFromIPC/tableToIPC calls)
   *
   * The client is responsible for parsing the IPC bytes.
   *
   * @param chunks - External links to Arrow IPC data
   * @param schema - Schema from Databricks manifest
   * @param signal - Optional abort signal
   * @returns Raw concatenated IPC bytes with schema
   */
  async processChunks(
    chunks: ExternalLink[],
    schema: ResultManifest["schema"],
    signal?: AbortSignal,
  ): Promise<ArrowRawResult> {
    if (chunks.length === 0) {
      throw ValidationError.missingField("chunks");
    }

    const buffers = await this.downloadChunksRaw(chunks, signal);
    const data = this.concatenateBuffers(buffers);

    return { data, schema };
  }

  /**
   * Download all chunks as raw bytes with concurrency control.
   */
  private async downloadChunksRaw(
    chunks: ExternalLink[],
    signal?: AbortSignal,
  ): Promise<Uint8Array[]> {
    const semaphore = new Semaphore(this.options.maxConcurrentDownloads);

    const downloadPromises = chunks.map(async (chunk) => {
      await semaphore.acquire();
      try {
        return await this.downloadChunkRaw(chunk, signal);
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(downloadPromises);
  }

  /**
   * Download a single chunk as raw bytes with retry logic.
   */
  private async downloadChunkRaw(
    chunk: ExternalLink,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort();
      }, this.options.timeout);

      const combinedSignal = signal
        ? this.combineAbortSignals(signal, timeoutController.signal)
        : timeoutController.signal;

      try {
        const externalLink = chunk.external_link;
        if (!externalLink) {
          console.error("External link is required", chunk);
          continue;
        }

        const response = await fetch(externalLink, {
          signal: combinedSignal,
        });

        if (!response.ok) {
          throw ExecutionError.statementFailed(
            `Failed to download chunk ${chunk.chunk_index}: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
      } catch (error) {
        lastError = error as Error;

        if (timeoutController.signal.aborted) {
          lastError = new Error(
            `Chunk ${chunk.chunk_index} download timed out after ${this.options.timeout}ms`,
          );
        }

        if (signal?.aborted) {
          throw ExecutionError.canceled();
        }

        if (attempt < this.options.retries - 1) {
          await this.delay(2 ** attempt * BACKOFF_MULTIPLIER);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw ExecutionError.statementFailed(
      `Failed to download chunk ${chunk.chunk_index} after ${this.options.retries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Concatenate multiple Uint8Array buffers into a single buffer.
   * Pre-allocates the result array for efficiency.
   */
  private concatenateBuffers(buffers: Uint8Array[]): Uint8Array {
    if (buffers.length === 0) {
      throw ValidationError.missingField("buffers");
    }

    if (buffers.length === 1) {
      return buffers[0];
    }

    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (const buffer of buffers) {
      result.set(buffer, offset);
      offset += buffer.length;
    }

    return result;
  }

  /**
   * Combines multiple AbortSignals into one.
   * The combined signal aborts when any of the input signals abort.
   */
  private combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    return controller.signal;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();

      if (next) {
        next();
      }
    } else {
      this.permits++;
    }
  }
}
