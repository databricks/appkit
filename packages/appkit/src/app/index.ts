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
  readdir(dirPath: string, req: RequestLike): Promise<string[]>;
}

interface QueryResult {
  query: string;
  isAsUser: boolean;
}

/**
 * Abstraction for filesystem operations that works in both dev and production modes
 */
interface FileSystemAdapter {
  readdir(dirPath: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
}

export class AppManager {
  private readonly queriesDir = path.resolve(process.cwd(), "config/queries");

  /**
   * Validates that a file path is within the queries directory
   */
  private validatePath(fileName: string): string | null {
    const queryFilePath = path.join(this.queriesDir, fileName);
    const resolvedPath = path.resolve(queryFilePath);
    const resolvedQueriesDir = path.resolve(this.queriesDir);

    if (!resolvedPath.startsWith(resolvedQueriesDir)) {
      logger.error("Invalid query path: path traversal detected");
      return null;
    }

    return resolvedPath;
  }

  /**
   * Creates a filesystem adapter based on dev mode or production mode
   */
  private createFsAdapter(
    req?: RequestLike,
    devFileReader?: DevFileReader,
  ): FileSystemAdapter {
    const isDevMode = req?.query?.dev !== undefined;

    if (isDevMode && devFileReader && req) {
      // Dev mode: use WebSocket tunnel to read from local filesystem
      return {
        readdir: async (dirPath: string) => {
          const relativePath = path.relative(process.cwd(), dirPath);
          return devFileReader.readdir(relativePath, req);
        },
        readFile: async (filePath: string) => {
          const relativePath = path.relative(process.cwd(), filePath);
          return devFileReader.readFile(relativePath, req);
        },
      };
    }

    // Production mode: use server filesystem
    return {
      readdir: (dirPath: string) => fs.readdir(dirPath),
      readFile: (filePath: string) => fs.readFile(filePath, "utf8"),
    };
  }

  /**
   * Retrieves a query file by key from the queries directory
   * In dev mode with a request context, reads from local filesystem via WebSocket
   * @param queryKey - The query file name (without extension)
   * @param req - Optional request object to detect dev mode
   * @param devFileReader - Optional DevFileReader instance to read files from local filesystem
   * @returns The query content and execution mode (as user or as service principal)
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

    // Create filesystem adapter for dev or production mode
    const fsAdapter = this.createFsAdapter(req, devFileReader);

    // Priority order: .obo.sql first (as user), then .sql (as service principal)
    const oboFileName = `${queryKey}.obo.sql`;
    const defaultFileName = `${queryKey}.sql`;

    // List directory to find which query file exists
    let files: string[];
    try {
      files = await fsAdapter.readdir(this.queriesDir);
    } catch (error) {
      logger.error(
        `Failed to read queries directory: ${(error as Error).message}`,
      );
      return null;
    }

    // Determine which query file to use
    let queryFileName: string | null = null;
    let isAsUser = false;

    if (files.includes(oboFileName)) {
      queryFileName = oboFileName;
      isAsUser = true;

      // Warn if both variants exist
      if (files.includes(defaultFileName)) {
        logger.warn(
          `Both ${oboFileName} and ${defaultFileName} found for query ${queryKey}. Using ${oboFileName}.`,
        );
      }
    } else if (files.includes(defaultFileName)) {
      queryFileName = defaultFileName;
      isAsUser = false;
    }

    if (!queryFileName) {
      logger.error(`Query file not found: ${queryKey}`);
      return null;
    }

    // Validate and resolve the file path
    const resolvedPath = this.validatePath(queryFileName);
    if (!resolvedPath) {
      return null;
    }

    // Read the query file
    try {
      const query = await fsAdapter.readFile(resolvedPath);
      return { query, isAsUser };
    } catch (error) {
      logger.error(`Failed to read query file: ${(error as Error).message}`);
      return null;
    }
  }
}

export type { DevFileReader, QueryResult, RequestLike };
