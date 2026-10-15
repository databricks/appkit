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
    return this.getOrNull(`get branch ${name}`, name);
  }

  getEndpoint(name: string): Promise<LakebaseEndpoint | null> {
    return this.getOrNull(`get endpoint ${name}`, name);
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
