import fs from "node:fs/promises";
import path from "node:path";
import { type ILogger, LoggerManager } from "../observability";

interface RequestLike {
  query?: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

interface DevFileReader {
  readFile(filePath: string, req: RequestLike): Promise<string>;
}

export class AppManager {
  private logger: ILogger = LoggerManager.getLogger("app-manager");
  /**
   * Retrieves a query file by key from the queries directory
   * In dev mode with a request context, reads from local filesystem via WebSocket
   * @param queryKey - The query file name (without extension)
   * @param req - Optional request object to detect dev mode
   * @param devFileReader - Optional DevFileReader instance to read files from local filesystem
   * @returns The query content as a string
   * @throws Error if query key is invalid or file not found
   */
  async getAppQuery(
    queryKey: string,
    req?: RequestLike,
    devFileReader?: DevFileReader,
  ): Promise<string | null> {
    // Security: Sanitize query key to prevent path traversal
    if (!queryKey || !/^[a-zA-Z0-9_-]+$/.test(queryKey)) {
      this.logger.debug("Invalid query key format", {
        queryKey,
        reason:
          "Only alphanumeric characters, underscores, and hyphens are allowed.",
      });
      return null;
    }

    const queryFilePath = path.join(
      process.cwd(),
      "config/queries",
      `${queryKey}.sql`,
    );

    // Security: Validate resolved path is within queries directory
    const resolvedPath = path.resolve(queryFilePath);
    const queriesDir = path.resolve(process.cwd(), "config/queries");

    if (!resolvedPath.startsWith(queriesDir)) {
      this.logger.debug("Invalid query path - traversal detected", {
        queryKey,
      });
      return null;
    }

    // Check if we're in dev mode and should use WebSocket
    const isDevMode = req?.query?.dev !== undefined;

    if (isDevMode && devFileReader && req) {
      try {
        // Read from local filesystem via WebSocket tunnel
        const relativePath = path.relative(process.cwd(), resolvedPath);
        return await devFileReader.readFile(relativePath, req);
      } catch (error) {
        this.logger.debug("Failed to read query from dev tunnel", {
          queryKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    // Production mode: read from server filesystem
    try {
      const query = await fs.readFile(resolvedPath, "utf8");
      return query;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.debug("Query not found", { queryKey, path: resolvedPath });
        return null;
      }
      this.logger.debug("Failed to read query from filesystem", {
        queryKey,
        path: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export type { DevFileReader, RequestLike };
