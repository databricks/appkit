import { z } from "zod";

import type { ToolingRequest, ToolingWorkspaceClient } from "./context";

// Lakebase Postgres REST API through the SDK's unified-auth client. Paths,
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
  status?: { hosts?: { host?: string } };
}

export class LakebaseApiError extends Error {
  /** HTTP status of the failing call. */
  readonly statusCode?: number;
  /** What was being done, e.g. "create branch projects/p/branches/b". */
  readonly operation: string;

  constructor(
    operation: string,
    message: string,
    options: { statusCode?: number; cause?: unknown } = {},
  ) {
    super(`Lakebase: ${operation} failed: ${message}`, {
      cause: options.cause,
    });
    this.name = "LakebaseApiError";
    this.operation = operation;
    this.statusCode = options.statusCode;
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LakebaseApi {
  constructor(
    private readonly client: Pick<ToolingWorkspaceClient, "apiClient">,
  ) {}

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

  private async call<T>(
    operation: string,
    request: Omit<ToolingRequest, "headers" | "raw">,
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (request.payload !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    try {
      return (await this.client.apiClient.request({
        ...request,
        headers,
        raw: false,
      })) as T;
    } catch (error) {
      throw new LakebaseApiError(operation, messageOf(error), {
        statusCode: statusCodeOf(error),
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
      if (error instanceof LakebaseApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}
