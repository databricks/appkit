import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { FilesConnector } from "../../connectors/files";
import { createLogger } from "../../logging/logger";
import {
  FILES_DEFAULT_CONCURRENCY,
  FILES_MAX_BULK_CONCURRENCY,
} from "./defaults";
import type {
  BulkDownloadItem,
  BulkOperationOptions,
  BulkResult,
} from "./types";

const logger = createLogger("files:bulk");

/**
 * Creates a concurrency limiter that allows at most `concurrency` async
 * operations to run in parallel. Additional calls are queued in FIFO order.
 */
export function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        queue.shift()!();
      }
    }
  };
}

/**
 * Retries an async operation with exponential backoff.
 * Used for per-file retries inside bulk operations (outside the interceptor chain).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; initialDelay?: number } = {},
): Promise<T> {
  const { attempts = 3, initialDelay = 1000 } = opts;
  let lastError: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i < attempts - 1) {
        const delay = initialDelay * 2 ** i;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Resolves the effective concurrency for a bulk operation.
 * Per-call override > volume config > default.
 * Clamped to [1, FILES_MAX_BULK_CONCURRENCY] to prevent unbounded parallelism.
 */
export function resolveConcurrency(
  volumeConcurrency: number | undefined,
  options?: BulkOperationOptions,
): number {
  const raw =
    options?.concurrency ?? volumeConcurrency ?? FILES_DEFAULT_CONCURRENCY;
  if (!Number.isFinite(raw)) return FILES_DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(raw, FILES_MAX_BULK_CONCURRENCY));
}

/**
 * Uploads a single file with retry and returns a BulkResult.
 * Shared by both batch and streaming upload paths so bug fixes apply to both.
 */
async function uploadFile(
  connector: FilesConnector,
  client: WorkspaceClient,
  file: { path: string; content: Buffer },
): Promise<BulkResult> {
  try {
    await retryWithBackoff(() =>
      connector.upload(client, file.path, file.content),
    );
    return {
      path: file.path,
      success: true,
      bytesWritten: file.content.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Bulk upload failed for %s: %s", file.path, message);
    return { path: file.path, success: false, error: message };
  }
}

/**
 * Upload multiple files to a volume with concurrency control and per-file retry.
 * Partial failures do not abort the batch.
 * Results are returned in the same order as the input files.
 */
export async function executeBulkUpload(
  connector: FilesConnector,
  client: WorkspaceClient,
  files: { path: string; content: Buffer }[],
  concurrency: number,
): Promise<BulkResult[]> {
  const limit = createConcurrencyLimiter(concurrency);
  const results: BulkResult[] = new Array(files.length);

  await Promise.all(
    files.map((file, i) =>
      limit(async () => {
        results[i] = await uploadFile(connector, client, file);
      }),
    ),
  );

  return results;
}

/**
 * Upload files from an async iterable with concurrency control.
 * Tracks received file count against the declared total.
 * Results are returned in submission order (the order files arrive from the stream).
 */
export async function executeBulkUploadStream(
  connector: FilesConnector,
  client: WorkspaceClient,
  fileCount: number,
  stream: AsyncIterable<{ path: string; content: Buffer }>,
  concurrency: number,
): Promise<BulkResult[]> {
  const limit = createConcurrencyLimiter(concurrency);
  const pending: Promise<void>[] = [];
  const results: BulkResult[] = [];
  let received = 0;

  for await (const file of stream) {
    const idx = received;
    received++;
    if (received > fileCount) {
      logger.warn(
        "Bulk upload stream received more files (%d) than declared (%d). Extra files will still be uploaded.",
        received,
        fileCount,
      );
    }

    pending.push(
      limit(async () => {
        results[idx] = await uploadFile(connector, client, file);
      }),
    );
  }

  // Wait for all in-flight uploads to complete
  await Promise.all(pending);

  if (received < fileCount) {
    logger.warn(
      "Bulk upload stream ended after %d files, expected %d.",
      received,
      fileCount,
    );
  }

  return results;
}

/**
 * Download multiple files from a volume as an async generator.
 * Yields one item per requested path (success or failure).
 */
export async function* executeBulkDownload(
  connector: FilesConnector,
  client: WorkspaceClient,
  paths: string[],
  concurrency: number,
): AsyncGenerator<BulkDownloadItem> {
  const limit = createConcurrencyLimiter(concurrency);

  // Launch all downloads concurrently (bounded by limiter) and collect promises
  // that resolve in completion order. We yield results as they arrive.
  const pending = paths.map((path) =>
    limit(async (): Promise<BulkDownloadItem> => {
      try {
        const result = await retryWithBackoff(async () => {
          const response = await connector.download(client, path);
          if (!response.contents) {
            return Buffer.alloc(0);
          }
          const chunks: Uint8Array[] = [];
          const reader = response.contents.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          return Buffer.concat(chunks);
        });
        return { path, content: result, error: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Bulk download failed for %s: %s", path, message);
        return { path, content: null, error: message };
      }
    }),
  );

  for (const promise of pending) {
    yield await promise;
  }
}
