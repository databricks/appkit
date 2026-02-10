import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type pg from "pg";
import { ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type {
  DatabaseCredential,
  GenerateDatabaseCredentialRequest,
} from "./auth-types";

const logger = createLogger("connectors:lakebase:utils");

/**
 * Map an SSL mode string to the corresponding `pg` SSL configuration.
 *
 * - `"require"` -- SSL enabled with certificate verification
 * - `"prefer"`  -- SSL enabled without certificate verification (try SSL, accept any cert)
 * - `"disable"` -- SSL disabled
 *
 * @param sslMode - The SSL mode to map
 * @returns pg-compatible SSL config value
 */
export function mapSslConfig(
  sslMode: "require" | "prefer" | "disable",
): pg.PoolConfig["ssl"] {
  switch (sslMode) {
    case "require":
      return { rejectUnauthorized: true };
    case "prefer":
      return { rejectUnauthorized: false };
    case "disable":
      return false;
  }
}

/**
 * Generate OAuth credentials for Postgres database connection using the proper Postgres API.
 *
 * This generates a time-limited OAuth token (expires after 1 hour) that can be used
 * as a password when connecting to Lakebase Postgres databases.
 *
 * @param workspaceClient - Databricks workspace client for authentication
 * @param request - Request parameters including endpoint path and optional UC claims
 * @returns Database credentials with OAuth token and expiration time
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/authentication
 *
 * @example
 * ```typescript
 * // Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
 * // Note: Use actual IDs from Databricks (project-id is a UUID)
 * const credential = await generateDatabaseCredential(workspaceClient, {
 *   endpoint: "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0"
 * });
 *
 * // Use credential.token as password
 * const conn = await pg.connect({
 *   host: "ep-abc123.database.us-east-1.databricks.com",
 *   user: "user@example.com",
 *   password: credential.token
 * });
 * ```
 *
 * @example With UC table permissions
 * ```typescript
 * // Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
 * const credential = await generateDatabaseCredential(workspaceClient, {
 *   endpoint: "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0",
 *   claims: [{
 *     permission_set: RequestedClaimsPermissionSet.READ_ONLY,
 *     resources: [{ table_name: "catalog.schema.users" }]
 *   }]
 * });
 * ```
 */
export async function generateDatabaseCredential(
  workspaceClient: WorkspaceClient,
  request: GenerateDatabaseCredentialRequest,
): Promise<DatabaseCredential> {
  const apiPath = "/api/2.0/postgres/credentials";

  // Get workspace ID from execution context or environment
  let workspaceId: string | undefined;
  try {
    const { getWorkspaceId } = await import("../../context");
    workspaceId = await getWorkspaceId();
  } catch {
    workspaceId = process.env.DATABRICKS_WORKSPACE_ID;
  }

  try {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    });

    // Manually add X-Databricks-Org-Id header if workspace ID is available
    // The SDK's automatic header addition doesn't work because config.workspaceId isn't set
    if (workspaceId) {
      headers.set("X-Databricks-Org-Id", workspaceId);
    }

    const response = await workspaceClient.apiClient.request({
      path: apiPath,
      method: "POST",
      headers,
      raw: false,
      payload: request,
    });

    return validateCredentialResponse(response);
  } catch (error) {
    logger.error("Failed to generate database credential: %O", {
      error,
      message: error instanceof Error ? error.message : String(error),
      endpoint: request.endpoint,
    });
    throw error;
  }
}

/** Validate the API response has the expected shape */
function validateCredentialResponse(response: unknown): DatabaseCredential {
  if (
    typeof response !== "object" ||
    response === null ||
    !("token" in response) ||
    !("expire_time" in response)
  ) {
    throw ValidationError.invalidValue(
      "credential response",
      response,
      "an object with { token, expire_time }",
    );
  }

  const { token, expire_time } = response as Record<string, unknown>;

  if (typeof token !== "string" || typeof expire_time !== "string") {
    throw ValidationError.invalidValue(
      "credential response fields",
      { tokenType: typeof token, expireTimeType: typeof expire_time },
      "token and expire_time to be strings",
    );
  }

  return { token, expire_time };
}
