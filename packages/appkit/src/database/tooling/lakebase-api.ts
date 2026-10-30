import { z } from "zod";

import type { ToolingRequest, ToolingWorkspaceClient } from "./context";

// Lakebase Postgres REST API through the workspace client's raw requests. Paths,
// query parameters and bodies mirror the Go SDK (service/postgres/impl.go).

export interface LakebaseBranch {
  name: string;
  status?: {
    default?: boolean;
    is_protected?: boolean;
    current_state?: string;
    expire_time?: string;
    source_branch?: string;
  };
}

export interface LakebaseEndpoint {
  name: string;
  status?: {
    endpoint_type?: string;
    hosts?: { host?: string };
  };
}

export interface LakebaseRole {
  name: string;
  status?: {
    postgres_role?: string;
    membership_roles?: string[];
  };
}

export interface LakebaseDatabase {
  name: string;
  status?: { postgres_database?: string };
}

export type IdentityType = "USER" | "SERVICE_PRINCIPAL";

export const SUPERUSER_MEMBERSHIP = "DATABRICKS_SUPERUSER";
export const READ_WRITE_ENDPOINT = "ENDPOINT_TYPE_READ_WRITE";

export interface RoleSpec {
  identity_type: IdentityType;
  postgres_role: string;
  auth_method: "LAKEBASE_OAUTH_V1";
  membership_roles: [typeof SUPERUSER_MEMBERSHIP];
}

export type BranchSpec = { source_branch: string } & (
  | { no_expiry: true }
  | { ttl: string }
);

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string; error_code?: string };
  response?: unknown;
}

export class LakebaseApiError extends Error {
  /** HTTP status of the failing call; absent for a failed long-running operation. */
  readonly statusCode?: number;
  /** The API's error code, e.g. ALREADY_EXISTS, from the call or the operation. */
  readonly errorCode?: string;
  /** What was being done, e.g. "create branch projects/p/branches/b". */
  readonly operation: string;

  constructor(
    operation: string,
    message: string,
    options: { statusCode?: number; errorCode?: string; cause?: unknown } = {},
  ) {
    super(`Lakebase: ${operation} failed: ${message}`, {
      cause: options.cause,
    });
    this.name = "LakebaseApiError";
    this.operation = operation;
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
  }
}

function failedWith(
  error: unknown,
  statusCode: number,
  errorCodes: readonly string[],
): boolean {
  return (
    error instanceof LakebaseApiError &&
    (error.statusCode === statusCode ||
      (error.errorCode !== undefined && errorCodes.includes(error.errorCode)))
  );
}

export const isAlreadyExists = (error: unknown) =>
  failedWith(error, 409, ["ALREADY_EXISTS", "RESOURCE_ALREADY_EXISTS"]);
export const isPermissionDenied = (error: unknown) =>
  failedWith(error, 403, ["PERMISSION_DENIED"]);
const isNotFound = (error: unknown) =>
  failedWith(error, 404, ["NOT_FOUND", "RESOURCE_DOES_NOT_EXIST"]);

/** The project holds as many branches as it may: "unarchived branches limit exceeded". */
export function isBranchLimit(error: unknown): boolean {
  return (
    error instanceof LakebaseApiError &&
    /branches limit exceeded/i.test(error.message)
  );
}

const API = "/api/2.0/postgres";

// The guard decides from these fields whether a command may write to a branch.
// A response without them must fail, not read as "not default, not protected".
const branchResponse = z.looseObject({
  name: z.string(),
  status: z.looseObject({
    default: z.boolean().optional(),
    is_protected: z.boolean().optional(),
    current_state: z.string().optional(),
    expire_time: z.string().optional(),
    source_branch: z.string().optional(),
  }),
});

const endpointResponse = z.looseObject({
  name: z.string(),
  status: z
    .looseObject({
      hosts: z.looseObject({ host: z.string().optional() }).optional(),
    })
    .optional(),
});

function statusCodeOf(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { errorCode?: unknown } | undefined)?.errorCode;
  return typeof code === "string" && code ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Workspace requests take string query values; unset ones are left out. */
function encodeQuery(
  query: ToolingRequest["query"],
): Record<string, string> | undefined {
  const entries = Object.entries(query ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, String(value)] as const],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LakebaseApiOptions {
  /** First poll delay for long-running operations; doubles up to 5 s. */
  readonly pollIntervalMs?: number;
  /** Give up waiting for one long-running operation after this long. */
  readonly timeoutMs?: number;
}

export class LakebaseApi {
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly client: Pick<ToolingWorkspaceClient, "request">,
    options: LakebaseApiOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  getBranch(name: string): Promise<LakebaseBranch | null> {
    return this.getParsedOrNull(`get branch ${name}`, name, branchResponse);
  }

  getEndpoint(name: string): Promise<LakebaseEndpoint | null> {
    return this.getParsedOrNull(`get endpoint ${name}`, name, endpointResponse);
  }

  private async getParsedOrNull<T>(
    operation: string,
    name: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const response = await this.getOrNull<unknown>(operation, name);
    if (response === null) return null;
    const parsed = schema.safeParse(response);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new LakebaseApiError(operation, `unexpected response (${issues})`);
  }

  listBranches(project: string): Promise<LakebaseBranch[]> {
    return this.list(
      `list branches of ${project}`,
      `${project}/branches`,
      "branches",
    );
  }

  async createBranch(
    project: string,
    branchId: string,
    spec: BranchSpec,
  ): Promise<LakebaseBranch> {
    const operation = `create branch ${project}/branches/${branchId}`;
    const op = await this.call<Operation>(operation, {
      path: `${API}/${project}/branches`,
      method: "POST",
      query: { branch_id: branchId },
      payload: { spec },
    });
    return this.wait<LakebaseBranch>(operation, op);
  }

  listEndpoints(branch: string): Promise<LakebaseEndpoint[]> {
    return this.list(
      `list endpoints of ${branch}`,
      `${branch}/endpoints`,
      "endpoints",
    );
  }

  /** A read-write endpoint that suspends after `suspendTimeout` idle (e.g. "300s"). */
  async createEndpoint(
    branch: string,
    endpointId: string,
    options: { suspendTimeout: string },
  ): Promise<LakebaseEndpoint> {
    const operation = `create endpoint ${branch}/endpoints/${endpointId}`;
    const op = await this.call<Operation>(operation, {
      path: `${API}/${branch}/endpoints`,
      method: "POST",
      query: { endpoint_id: endpointId },
      payload: {
        spec: {
          endpoint_type: READ_WRITE_ENDPOINT,
          suspend_timeout_duration: options.suspendTimeout,
        },
      },
    });
    return this.wait<LakebaseEndpoint>(operation, op);
  }

  /** A branch that is already gone counts as deleted. */
  async deleteBranch(name: string): Promise<void> {
    await this.deleteResource(`delete branch ${name}`, {
      path: `${API}/${name}`,
    });
  }

  getDatabase(name: string): Promise<LakebaseDatabase | null> {
    return this.getOrNull(`get database ${name}`, name);
  }

  listRoles(branch: string): Promise<LakebaseRole[]> {
    return this.list(`list roles of ${branch}`, `${branch}/roles`, "roles");
  }

  /** Without a role_id; the API derives one (sidesteps the USER role_id format). */
  async createRole(branch: string, spec: RoleSpec): Promise<LakebaseRole> {
    const operation = `create role ${spec.postgres_role} on ${branch}`;
    const op = await this.call<Operation>(operation, {
      path: `${API}/${branch}/roles`,
      method: "POST",
      payload: { spec },
    });
    return this.wait<LakebaseRole>(operation, op);
  }

  async setRoleMemberships(
    role: string,
    memberships: RoleSpec["membership_roles"],
  ): Promise<LakebaseRole> {
    const operation = `update role ${role}`;
    const op = await this.call<Operation>(operation, {
      path: `${API}/${role}`,
      method: "PATCH",
      query: { update_mask: "spec.membership_roles" },
      payload: { spec: { membership_roles: memberships } },
    });
    return this.wait<LakebaseRole>(operation, op);
  }

  /** Every object the role owns is reassigned first (runs SQL on the branch's compute). */
  async deleteRole(
    role: string,
    options: { reassignOwnedTo: string },
  ): Promise<void> {
    await this.deleteResource(`delete role ${role}`, {
      path: `${API}/${role}`,
      query: { reassign_owned_to: options.reassignOwnedTo },
    });
  }

  private async deleteResource(
    operation: string,
    request: { path: string; query?: ToolingRequest["query"] },
  ): Promise<void> {
    try {
      const op = await this.call<Operation>(operation, {
        ...request,
        method: "DELETE",
      });
      await this.wait<unknown>(operation, op);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async call<T>(
    operation: string,
    request: ToolingRequest,
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (request.payload !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    try {
      const response = await this.client.request({
        method: request.method,
        path: request.path,
        query: encodeQuery(request.query),
        headers,
        body:
          request.payload === undefined
            ? undefined
            : JSON.stringify(request.payload),
      });
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      throw new LakebaseApiError(operation, messageOf(error), {
        statusCode: statusCodeOf(error),
        errorCode: errorCodeOf(error),
        cause: error,
      });
    }
  }

  private async getOrNull<T>(
    operation: string,
    name: string,
  ): Promise<T | null> {
    try {
      return await this.call<T>(operation, {
        path: `${API}/${name}`,
        method: "GET",
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async list<T>(
    operation: string,
    collection: string,
    key: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<Record<string, unknown>>(operation, {
        path: `${API}/${collection}`,
        method: "GET",
        ...(pageToken ? { query: { page_token: pageToken } } : {}),
      });
      items.push(...((page?.[key] as T[] | undefined) ?? []));
      pageToken = (page?.next_page_token as string | undefined) || undefined;
    } while (pageToken);
    return items;
  }

  /** Poll GET /api/2.0/postgres/{operation.name} until done. */
  private async wait<T>(operation: string, first: Operation): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    let delay = this.pollIntervalMs;
    let current = first;
    while (!current?.done) {
      if (!current?.name) {
        throw new LakebaseApiError(
          operation,
          "the API returned an unfinished operation without a name",
        );
      }
      if (Date.now() >= deadline) {
        throw new LakebaseApiError(
          operation,
          `timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${current.name}`,
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
      current = await this.call<Operation>(operation, {
        path: `${API}/${current.name}`,
        method: "GET",
      });
    }
    if (current.error) {
      throw new LakebaseApiError(
        operation,
        current.error.message ?? current.error.error_code ?? "unknown error",
        { errorCode: current.error.error_code },
      );
    }
    return current.response as T;
  }
}
