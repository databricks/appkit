import type { ExternalLink, ResultManifest } from '@databricks-apps/connectors';
import { Table, tableFromIPC, tableToIPC } from 'apache-arrow';

export interface ArrowStreamOptions {
  maxConcurrentDownloads: number;
  timeout: number;
  retries: number;
}

export interface ArrowStreamResult {
  data: Uint8Array;
  schema: ResultManifest['schema'];
  metadata: {
    rowCount: number;
    columnCount: number;
  }
}

export class ArrowStreamProcessor {
  constructor(private options: ArrowStreamOptions = {
    maxConcurrentDownloads: 5,
    timeout: 30000,
    retries: 3,
  }) {
    this.options = {
      maxConcurrentDownloads: options.maxConcurrentDownloads ?? 5,
      timeout: options.timeout ?? 30000,
      retries: options.retries ?? 3,
    };
  }

  async processChunks(
    chunks: ExternalLink[],
    schema: ResultManifest['schema'],
    signal?: AbortSignal
  ): Promise<ArrowStreamResult> {
    if (chunks.length === 0) {
      throw new Error('No Arrow chunks provided');
    }

    const tables = await this.downloadAndParseChunks(chunks, signal);
    const concatenatedTable = this.concatenateTables(tables);
    const serializedData = tableToIPC(concatenatedTable);

    return {
      data: serializedData,
      schema,
      metadata: {
        rowCount: concatenatedTable.numRows,
        columnCount: concatenatedTable.numCols
      }
    };
  }

  private async downloadAndParseChunks(
    chunks: ExternalLink[],
    signal?: AbortSignal
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
      try {
        const response = await fetch(chunk.external_link, {
          signal,
          timeout: this.options.timeout
        } as RequestInit);

        if (!response.ok) {
          throw new Error(`Failed to download chunk ${chunk.chunk_index}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        return tableFromIPC(uint8Array);
      } catch (error) {
        lastError = error as Error;
        
        if (signal?.aborted) {
          throw new Error('Arrow stream processing was aborted');
        }

        if (attempt < this.options.retries - 1) {
          await this.delay(2 ** attempt * 1000);
        }
      }
    }

    throw new Error(`Failed to download chunk ${chunk.chunk_index} after ${this.options.retries} attempts: ${lastError?.message}`);
  }

  private concatenateTables(tables: Table[]): Table {
    if (tables.length === 1) {
      return tables[0];
    }

    const firstTable = tables[0];
    const schema = firstTable.schema;

    for (let i = 1; i < tables.length; i++) {
      if (!schema.equals(tables[i].schema)) {
        throw new Error(`Schema mismatch in Arrow chunks: chunk 0 vs chunk ${i}`);
      }
    }

    return new Table(schema, ...tables.flatMap(table => table.batches));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

    return new Promise<void>(resolve => {
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