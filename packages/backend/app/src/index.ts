import fs from "node:fs/promises";
import path from "node:path";

export class AppManager {
  /**
   * Retrieves a query file by key from the queries directory
   * @param queryKey - The query file name (without extension)
   * @returns The query content as a string
   * @throws Error if query key is invalid or file not found
   */
  async getAppQuery(queryKey: string): Promise<string> {
    // Security: Sanitize query key to prevent path traversal
    if (!queryKey || !/^[a-zA-Z0-9_-]+$/.test(queryKey)) {
      throw new Error(
        `Invalid query key format: "${queryKey}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
      );
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
      throw new Error(`Invalid query path: path traversal detected`);
    }

    try {
      const query = await fs.readFile(resolvedPath, "utf8");
      return query;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Query "${queryKey}" not found at path: ${resolvedPath}`,
        );
      }
      throw error;
    }
  }
}
