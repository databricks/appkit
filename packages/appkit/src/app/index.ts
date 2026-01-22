import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logging/logger";

const logger = createLogger("app");

interface RequestLike {
  query?: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

interface DevFileReader {
  readFile(filePath: string, req: RequestLike): Promise<string>;
}

interface QueryResult {
  query: string;
  isAsUser: boolean;
}

export class AppManager {
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
  ): Promise<QueryResult | null> {
    // Security: Sanitize query key to prevent path traversal
    if (!queryKey || !/^[a-zA-Z0-9_-]+$/.test(queryKey)) {
      logger.error(
        "Invalid query key format: %s. Only alphanumeric characters, underscores, and hyphens are allowed.",
        queryKey,
      );
      return null;
    }

    const queriesDir = path.resolve(process.cwd(), "config/queries");

    // priority order: .obo.sql first (asUser), then .sql (default)
    const oboFileName = `${queryKey}.obo.sql`;
    const defaultFileName = `${queryKey}.sql`;

    let queryFileName: string | null = null;
    let isAsUser: boolean = false;

    try {
      const files = await fs.readdir(queriesDir);

      // check for OBO query first
      if (files.includes(oboFileName)) {
        queryFileName = oboFileName;
        isAsUser = true;

        // check for both files and warn if both are present
        if (files.includes(defaultFileName)) {
          logger.warn(
            `Both ${oboFileName} and ${defaultFileName} found for query ${queryKey}. Using ${oboFileName}.`,
          );
        }
        // check for default query if OBO query is not present
      } else if (files.includes(defaultFileName)) {
        queryFileName = defaultFileName;
        isAsUser = false;
      }
    } catch (error) {
      logger.error(
        `Failed to read queries directory: ${(error as Error).message}`,
      );
      return null;
    }

    if (!queryFileName) {
      logger.error(`Query file not found: ${queryKey}`);
      return null;
    }

    const queryFilePath = path.join(queriesDir, queryFileName);

    // security: validate resolved path is within queries directory
    const resolvedPath = path.resolve(queryFilePath);
    const resolvedQueriesDir = path.resolve(queriesDir);

    if (!resolvedPath.startsWith(resolvedQueriesDir)) {
      logger.error(`Invalid query path: path traversal detected`);
      return null;
    }

    // check if we're in dev mode and should use WebSocket
    const isDevMode = req?.query?.dev !== undefined;
    if (isDevMode && devFileReader && req) {
      try {
        const relativePath = path.relative(process.cwd(), resolvedPath);
        return {
          query: await devFileReader.readFile(relativePath, req),
          isAsUser,
        };
      } catch (error) {
        logger.error(
          `Failed to read query from dev tunnel: ${(error as Error).message}`,
        );
        return null;
      }
    }

    // production mode: read from server filesystem
    try {
      const query = await fs.readFile(resolvedPath, "utf8");
      return { query, isAsUser };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.error(
          `Failed to read query from server filesystem: ${(error as Error).message}`,
        );
        return null;
      }

      logger.error(
        `Failed to read query from server filesystem: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

export type { DevFileReader, QueryResult, RequestLike };
