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
  private readonly _queriesDir: string;
  private readonly _metricViewsDir: string;

  constructor(
    queriesDir: string = path.resolve(process.cwd(), "config/queries"),
    // Metric-view declarations live in a sibling `config/metric-views/`
    // directory (next to `config/queries/` and `config/agents/`), NOT inside
    // the queries folder. Default it as a sibling of `queriesDir` so a
    // single-arg `new AppManager(dir)` (and every test that overrides only the
    // queries dir) still resolves the metric-views dir consistently.
    metricViewsDir: string = path.resolve(
      path.dirname(queriesDir),
      "metric-views",
    ),
  ) {
    this._queriesDir = queriesDir;
    this._metricViewsDir = metricViewsDir;
  }

  get queriesDir(): string {
    return this._queriesDir;
  }

  get metricViewsDir(): string {
    return this._metricViewsDir;
  }

  /**
   * Whether `req` is a dev-tunnel (`?dev`) request. Internal `?dev` predicate
   * shared by {@link createFsAdapter} (tunnel-vs-`fs` branch) and
   * {@link isNotFoundError} (dev's message-match not-found classification).
   */
  private isDevRequest(req?: RequestLike): boolean {
    return req?.query?.dev !== undefined;
  }

  /**
   * Validates that a file path is within the given base directory. The
   * `baseDir` is passed explicitly (rather than pinned to `queriesDir`) so the
   * same traversal guard protects reads from any config directory —
   * `config/queries/` for `.sql` files and `config/metric-views/` for the
   * metric-view definitions.
   */
  private validatePath(fileName: string, baseDir: string): string | null {
    const filePath = path.join(baseDir, fileName);
    const resolvedPath = path.resolve(filePath);
    const resolvedBaseDir = path.resolve(baseDir);

    if (!resolvedPath.startsWith(resolvedBaseDir)) {
      logger.error("Invalid config path: path traversal detected");
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
    const isDevMode = this.isDevRequest(req);

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
    const resolvedPath = this.validatePath(queryFileName, this._queriesDir);
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

  /**
   * Read a single config file from a given base directory, dev-tunnel-aware.
   * Shared core behind {@link readConfigFile} (queries dir) and
   * {@link readMetricViewsConfig} (metric-views dir).
   *
   * @param baseDir - The config directory the file must resolve within.
   * @param fileName - File name (or relative path) within `baseDir`.
   * @param req - Optional request object to detect dev mode.
   * @param devFileReader - Optional DevFileReader to read via the WebSocket tunnel.
   * @returns The raw file contents, or `null` when the file is absent / the path is rejected.
   */
  private async readFileFromDir(
    baseDir: string,
    fileName: string,
    req?: RequestLike,
    devFileReader?: DevFileReader,
  ): Promise<string | null> {
    // Traversal guard: refuse to read outside the base directory.
    const resolvedPath = this.validatePath(fileName, baseDir);
    if (!resolvedPath) {
      return null;
    }

    const fsAdapter = this.createFsAdapter(req, devFileReader);

    try {
      return await fsAdapter.readFile(resolvedPath);
    } catch (error) {
      if (this.isNotFoundError(error, req)) {
        return null;
      }
      // Any other error (permission / IO / tunnel) is fatal: propagate so the
      // caller can distinguish it from a dormant (absent) config.
      throw error;
    }
  }

  /**
   * Read a single config file from the queries directory, dev-tunnel-aware.
   *
   * @param fileName - File name (or relative path) within the queries directory.
   * @param req - Optional request object to detect dev mode.
   * @param devFileReader - Optional DevFileReader to read via the WebSocket tunnel.
   * @returns The raw file contents, or `null` when the file is absent / the path is rejected.
   */
  async readConfigFile(
    fileName: string,
    req?: RequestLike,
    devFileReader?: DevFileReader,
  ): Promise<string | null> {
    return this.readFileFromDir(this._queriesDir, fileName, req, devFileReader);
  }

  /**
   * Read a single config file from the metric-views directory
   * (`config/metric-views/`), dev-tunnel-aware. Same absent-file/traversal
   * semantics as {@link readConfigFile}, but rooted at {@link metricViewsDir}.
   *
   * @param fileName - File name (or relative path) within the metric-views directory.
   * @param req - Optional request object to detect dev mode.
   * @param devFileReader - Optional DevFileReader to read via the WebSocket tunnel.
   * @returns The raw file contents, or `null` when the file is absent / the path is rejected.
   */
  async readMetricViewsConfig(
    fileName: string,
    req?: RequestLike,
    devFileReader?: DevFileReader,
  ): Promise<string | null> {
    return this.readFileFromDir(
      this._metricViewsDir,
      fileName,
      req,
      devFileReader,
    );
  }

  private isNotFoundError(error: unknown, req?: RequestLike): boolean {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return true;
    }
    if (this.isDevRequest(req)) {
      const message = (error as Error)?.message ?? "";
      return /ENOENT|no such file/i.test(message);
    }
    return false;
  }
}

export type { DevFileReader, RequestLike };
