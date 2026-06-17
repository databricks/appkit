import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { ValidationError } from "./errors";
import type {
  DatabaseCredential,
  GenerateDatabaseCredentialRequest,
} from "./types";

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
 * // Use the `name` field from the Databricks CLI output:
 * // `databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}`
 * const credential = await generateDatabaseCredential(workspaceClient, {
 *   endpoint: "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
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
 * // Use the `name` field from the Databricks CLI output:
 * // `databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}`
 * const credential = await generateDatabaseCredential(workspaceClient, {
 *   endpoint: "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}",
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

  const response = await workspaceClient.apiClient.request({
    path: apiPath,
    method: "POST",
    headers: new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    raw: false,
    payload: request,
  });

  return validateCredentialResponse(response);
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
