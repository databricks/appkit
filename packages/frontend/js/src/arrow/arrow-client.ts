import { type Table, tableFromIPC } from "apache-arrow";

export class ArrowClient {
  static processArrowBuffer(buffer: Uint8Array): Table {
    try {
      return tableFromIPC(buffer);
    } catch (error) {
      throw new Error(
        `Failed to process Arrow buffer: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  static async fetchAndProcessArrow(
    url: string,
    headers?: Record<string, string>
  ): Promise<Table> {
    try {
      const buffer = await ArrowClient.fetchArrow(url, headers);

      return ArrowClient.processArrowBuffer(buffer);
    } catch (error) {
      throw new Error(
        `Failed to fetch Arrow data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  static async fetchArrow(
    url: string,
    headers?: Record<string, string>
  ): Promise<Uint8Array> {
    try {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/octet-stream", ...headers },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();

      return new Uint8Array(buffer);
    } catch (error) {
      throw new Error(
        `Failed to fetch Arrow data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}
