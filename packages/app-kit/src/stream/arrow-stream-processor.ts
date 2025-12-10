import { Table, tableFromIPC, tableToIPC } from "apache-arrow";
import type { sql } from "@databricks/sdk-experimental";

type ResultManifest = sql.ResultManifest;
type ExternalLink = sql.ExternalLink;
export interface ArrowStreamOptions {
  maxConcurrentDownloads: number;
  timeout: number;
  retries: number;
}

export interface ArrowStreamResult {
  data: Uint8Array;
  schema: ResultManifest["schema"];
  metadata: {
    rowCount: number;
    columnCount: number;
  };
}

export class ArrowStreamProcessor {
  constructor(
    private options: ArrowStreamOptions = {
      maxConcurrentDownloads: 5,
      timeout: 30000,
      retries: 3,
    },
  ) {
    this.options = {
      maxConcurrentDownloads: options.maxConcurrentDownloads ?? 5,
      timeout: options.timeout ?? 30000,
      retries: options.retries ?? 3,
    };
  }

  async processChunks(
    chunks: ExternalLink[],
    schema: ResultManifest["schema"],
    signal?: AbortSignal,
  ): Promise<ArrowStreamResult> {
    if (chunks.length === 0) {
      throw new Error("No Arrow chunks provided");
    }

    const tables = await this.downloadAndParseChunks(chunks, signal);
    const concatenatedTable = this.concatenateTables(tables);
    const serializedData = tableToIPC(concatenatedTable);

    return {
      data: serializedData,
      schema,
      metadata: {
        rowCount: concatenatedTable.numRows,
        columnCount: concatenatedTable.numCols,
      },
    };
  }

  private async downloadAndParseChunks(
    chunks: ExternalLink[],
    signal?: AbortSignal,
  ): Promise<Table[]> {
    const semaphore = new Semaphore(this.options.maxConcurrentDownloads);

    const downloadPromises = chunks.map(async (chunk) => {
      await semaphore.acquire();
      try {
        return await this.downloadAndParseChunk(chunk, signal);
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(downloadPromises);
  }

  private async downloadAndParseChunk(
    chunk: ExternalLink,
    signal?: AbortSignal,
  ): Promise<Table> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      // Create a timeout controller for this attempt
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort();
      }, this.options.timeout);

      // Combine external signal with timeout signal
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
          throw new Error(
            `Failed to download chunk ${chunk.chunk_index}: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        return tableFromIPC(uint8Array);
      } catch (error) {
        lastError = error as Error;

        // Check if it was a timeout
        if (timeoutController.signal.aborted) {
          lastError = new Error(
            `Chunk ${chunk.chunk_index} download timed out after ${this.options.timeout}ms`,
          );
        }

        // Check if external abort was requested
        if (signal?.aborted) {
          throw new Error("Arrow stream processing was aborted");
        }

        if (attempt < this.options.retries - 1) {
          await this.delay(2 ** attempt * 1000);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error(
      `Failed to download chunk ${chunk.chunk_index} after ${this.options.retries} attempts: ${lastError?.message}`,
    );
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

  private concatenateTables(tables: Table[]): Table {
    if (tables.length === 1) {
      return tables[0];
    }

    const firstTable = tables[0];
    const schema = firstTable.schema;

    // Validate schemas and count total batches in a single pass
    let totalBatches = firstTable.batches.length;
    for (let i = 1; i < tables.length; i++) {
      const table = tables[i];
      // Arrow Schema objects do not have an 'equals' method in the official API.
      if (
        schema.fields.length !== table.schema.fields.length ||
        !schema.fields.every(
          (f, idx) =>
            f.name === table.schema.fields[idx].name &&
            f.type.toString() === table.schema.fields[idx].type.toString(),
        )
      ) {
        throw new Error(
          `Schema mismatch in Arrow chunks: chunk 0 vs chunk ${i}`,
        );
      }
      totalBatches += table.batches.length;
    }

    // Pre-allocate array to avoid intermediate allocations from flatMap/spread
    const allBatches = new Array(totalBatches);
    let offset = 0;
    for (let i = 0; i < tables.length; i++) {
      const batches = tables[i].batches;
      for (let j = 0; j < batches.length; j++) {
        allBatches[offset++] = batches[j];
      }
    }

    return new Table(schema, allBatches);
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
