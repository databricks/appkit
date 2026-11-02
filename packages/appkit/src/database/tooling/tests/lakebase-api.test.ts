import { describe, expect, test } from "vitest";

import type { WorkspaceRequest } from "../../../workspace-client";
import {
  isAlreadyExists,
  isBranchLimit,
  isPermissionDenied,
  LakebaseApi,
  LakebaseApiError,
} from "../lakebase-api";

/** A request as LakebaseApi sent it, with its JSON body decoded. */
interface Sent {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Headers;
  payload?: unknown;
}

type Reply = unknown | ((request: Sent) => unknown);

/** Workspace client fake: replies in order with JSON, records each request. */
function client(replies: Reply[]) {
  const requests: Sent[] = [];
  return {
    requests,
    async request(request: WorkspaceRequest): Promise<Response> {
      const sent: Sent = {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: new Headers(request.headers),
        payload:
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : undefined,
      };
      requests.push(sent);
      if (replies.length === 0)
        throw new Error(`unexpected request ${sent.method} ${sent.path}`);
      const reply = replies.shift();
      const value =
        typeof reply === "function"
          ? (reply as (r: Sent) => unknown)(sent)
          : reply;
      if (value instanceof Error) throw value;
      return new Response(value === undefined ? null : JSON.stringify(value));
    },
  };
}

const apiError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode, errorCode: "X" });

const fast = { pollIntervalMs: 1 };

describe("LakebaseApi", () => {
  test("getBranch: GET /api/2.0/postgres/{name}; 404 → null; other errors keep their status", async () => {
    const branch = {
      name: "projects/p/branches/b",
      status: { current_state: "READY" },
    };
    const fake = client([
      branch,
      apiError(404, "NOT_FOUND"),
      apiError(403, "PERMISSION_DENIED"),
    ]);
    const api = new LakebaseApi(fake, fast);

    await expect(api.getBranch("projects/p/branches/b")).resolves.toEqual(
      branch,
    );
    await expect(
      api.getBranch("projects/p/branches/missing"),
    ).resolves.toBeNull();
    const error = await api
      .getBranch("projects/p/branches/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LakebaseApiError);
    expect(error).toMatchObject({
      statusCode: 403,
      operation: "get branch projects/p/branches/x",
    });

    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches/b",
      method: "GET",
    });
    expect(fake.requests[0]?.query).toBeUndefined();
    expect(fake.requests[0]?.payload).toBeUndefined();
    expect(fake.requests[0]?.headers.get("Accept")).toBe("application/json");
    expect(fake.requests[0]?.headers.get("Content-Type")).toBeNull();
  });

  test("a request that fails before a status keeps its message and has no status", async () => {
    const api = new LakebaseApi(client([new Error("socket hang up")]));

    const error = await api
      .getBranch("projects/p/branches/b")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LakebaseApiError);
    expect(error).toMatchObject({
      message:
        "Lakebase: get branch projects/p/branches/b failed: socket hang up",
      statusCode: undefined,
    });
  });

  test("getEndpoint: GET /api/2.0/postgres/{name}; 404 → null", async () => {
    const endpoint = {
      name: "projects/p/branches/b/endpoints/primary",
      status: { hosts: { host: "ep-1.example.com" } },
    };
    const fake = client([endpoint, apiError(404, "NOT_FOUND")]);
    const api = new LakebaseApi(fake);

    await expect(api.getEndpoint(endpoint.name)).resolves.toEqual(endpoint);
    await expect(
      api.getEndpoint("projects/p/branches/b/endpoints/gone"),
    ).resolves.toBeNull();
    expect(
      fake.requests.map((request) => [request.method, request.path]),
    ).toEqual([
      ["GET", "/api/2.0/postgres/projects/p/branches/b/endpoints/primary"],
      ["GET", "/api/2.0/postgres/projects/p/branches/b/endpoints/gone"],
    ]);
  });

  test("getBranch refuses a branch the guard could not classify: no status, or a status of the wrong type", async () => {
    const api = new LakebaseApi(
      client([
        { name: "projects/p/branches/b" },
        { name: "projects/p/branches/b", status: { default: "true" } },
      ]),
    );

    await expect(api.getBranch("projects/p/branches/b")).rejects.toThrow(
      "Lakebase: get branch projects/p/branches/b failed: unexpected response (status: ",
    );
    await expect(api.getBranch("projects/p/branches/b")).rejects.toThrow(
      /unexpected response \(status\.default: /,
    );
  });

  test("getBranch keeps the fields it does not check", async () => {
    const branch = {
      name: "projects/p/branches/b",
      uid: "br-1",
      status: { default: true, logical_size_bytes: 10 },
    };
    const api = new LakebaseApi(client([branch]));

    await expect(api.getBranch(branch.name)).resolves.toEqual(branch);
  });

  test("getEndpoint refuses a response without a name", async () => {
    const api = new LakebaseApi(client([{ status: {} }]));

    await expect(
      api.getEndpoint("projects/p/branches/b/endpoints/primary"),
    ).rejects.toThrow(/unexpected response \(name: /);
  });

  test("lists follow next_page_token", async () => {
    const fake = client([
      { branches: [{ name: "a" }], next_page_token: "t2" },
      { branches: [{ name: "b" }] },
    ]);
    const branches = await new LakebaseApi(fake, fast).listBranches(
      "projects/p",
    );

    expect(branches.map((b) => b.name)).toEqual(["a", "b"]);
    expect(fake.requests.map((r) => [r.path, r.query])).toEqual([
      ["/api/2.0/postgres/projects/p/branches", undefined],
      ["/api/2.0/postgres/projects/p/branches", { page_token: "t2" }],
    ]);
  });

  test("createBranch: POST with branch_id and {spec}; a finished operation returns its response", async () => {
    const fake = client([
      {
        name: "projects/p/branches/dev-a/operations/1",
        done: true,
        response: { name: "projects/p/branches/dev-a" },
      },
    ]);
    const branch = await new LakebaseApi(fake, fast).createBranch(
      "projects/p",
      "dev-a",
      {
        source_branch: "projects/p/branches/production",
        no_expiry: true,
      },
    );

    expect(branch).toEqual({ name: "projects/p/branches/dev-a" });
    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches",
      method: "POST",
      query: { branch_id: "dev-a" },
      payload: {
        spec: {
          source_branch: "projects/p/branches/production",
          no_expiry: true,
        },
      },
    });
    expect(fake.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json",
    );
  });

  test("polls GET /api/2.0/postgres/{operation.name} until the operation is done", async () => {
    const op = "projects/p/branches/b/operations/7";
    const fake = client([
      { name: op, done: false },
      { name: op, done: false },
      {
        name: op,
        done: true,
        response: { name: "projects/p/branches/b/endpoints/primary" },
      },
    ]);
    const endpoint = await new LakebaseApi(fake, fast).createEndpoint(
      "projects/p/branches/b",
      "primary",
      { suspendTimeout: "300s" },
    );

    expect(endpoint.name).toBe("projects/p/branches/b/endpoints/primary");
    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches/b/endpoints",
      method: "POST",
      query: { endpoint_id: "primary" },
      payload: {
        spec: {
          endpoint_type: "ENDPOINT_TYPE_READ_WRITE",
          suspend_timeout_duration: "300s",
        },
      },
    });
    expect(fake.requests.slice(1).map((r) => [r.method, r.path])).toEqual([
      ["GET", `/api/2.0/postgres/${op}`],
      ["GET", `/api/2.0/postgres/${op}`],
    ]);
  });

  test("a failed operation becomes a LakebaseApiError with the operation's message", async () => {
    const fake = client([
      {
        name: "op",
        done: true,
        error: {
          error_code: "RESOURCE_EXHAUSTED",
          message: "branch limit reached",
        },
      },
    ]);
    await expect(
      new LakebaseApi(fake, fast).createBranch("projects/p", "dev-a", {
        source_branch: "projects/p/branches/production",
        no_expiry: true,
      }),
    ).rejects.toThrow(
      "Lakebase: create branch projects/p/branches/dev-a failed: branch limit reached",
    );
  });

  test("an operation that never finishes times out", async () => {
    const fake = client(
      Array.from({ length: 50 }, () => ({ name: "op", done: false })),
    );
    await expect(
      new LakebaseApi(fake, { pollIntervalMs: 1, timeoutMs: 5 }).createEndpoint(
        "projects/p/branches/b",
        "primary",
        { suspendTimeout: "300s" },
      ),
    ).rejects.toThrow(/timed out/);
  });

  test("error codes from the call and from a failed operation classify the failure", async () => {
    const create = (api: LakebaseApi) =>
      api
        .createBranch("projects/p", "dev-a", {
          source_branch: "projects/p/branches/production",
          no_expiry: true,
        })
        .catch((e: unknown) => e);
    const conflict = await create(
      new LakebaseApi(
        client([
          {
            name: "op",
            done: true,
            error: { error_code: "ALREADY_EXISTS", message: "exists" },
          },
        ]),
        fast,
      ),
    );
    const denied = await create(
      new LakebaseApi(client([apiError(403, "PERMISSION_DENIED")]), fast),
    );
    const limit = await create(
      new LakebaseApi(
        client([
          Object.assign(
            new Error("unarchived branches limit exceeded [TraceId: abc]"),
            { statusCode: 400, errorCode: "BAD_REQUEST" },
          ),
        ]),
        fast,
      ),
    );

    expect(conflict).toMatchObject({ errorCode: "ALREADY_EXISTS" });
    expect(isAlreadyExists(conflict)).toBe(true);
    expect(isPermissionDenied(conflict)).toBe(false);
    expect(isPermissionDenied(denied)).toBe(true);
    expect(isAlreadyExists(denied)).toBe(false);
    expect(limit).toMatchObject({ statusCode: 400, errorCode: "BAD_REQUEST" });
    expect(isBranchLimit(limit)).toBe(true);
    expect(isBranchLimit(denied)).toBe(false);
  });

  test("deleteBranch: DELETE the branch; one that is already gone counts as deleted", async () => {
    const fake = client([
      { name: "op", done: true },
      apiError(404, "NOT_FOUND"),
      {
        name: "op",
        done: true,
        error: { error_code: "RESOURCE_DOES_NOT_EXIST", message: "gone" },
      },
      apiError(403, "PERMISSION_DENIED"),
    ]);
    const api = new LakebaseApi(fake, fast);
    const name = "projects/p/branches/session-abc123-x";

    await api.deleteBranch(name);
    await api.deleteBranch(name);
    await api.deleteBranch(name);
    await expect(api.deleteBranch(name)).rejects.toMatchObject({
      statusCode: 403,
    });

    expect(fake.requests[0]).toMatchObject({
      path: `/api/2.0/postgres/${name}`,
      method: "DELETE",
    });
    expect(fake.requests[0]?.query).toBeUndefined();
  });

  test("createRole posts {spec} without a role_id", async () => {
    const fake = client([
      {
        name: "op",
        done: true,
        response: { name: "projects/p/branches/b/roles/r" },
      },
    ]);
    await new LakebaseApi(fake, fast).createRole("projects/p/branches/b", {
      identity_type: "USER",
      postgres_role: "alice@example.com",
      auth_method: "LAKEBASE_OAUTH_V1",
      membership_roles: ["DATABRICKS_SUPERUSER"],
    });

    expect(fake.requests[0]).toEqual(
      expect.objectContaining({
        path: "/api/2.0/postgres/projects/p/branches/b/roles",
        method: "POST",
        payload: {
          spec: {
            identity_type: "USER",
            postgres_role: "alice@example.com",
            auth_method: "LAKEBASE_OAUTH_V1",
            membership_roles: ["DATABRICKS_SUPERUSER"],
          },
        },
      }),
    );
    expect(fake.requests[0]?.query).toBeUndefined();
  });

  test("setRoleMemberships: PATCH with update_mask=spec.membership_roles", async () => {
    const fake = client([
      {
        name: "op",
        done: true,
        response: { name: "projects/p/branches/b/roles/r" },
      },
    ]);
    await new LakebaseApi(fake, fast).setRoleMemberships(
      "projects/p/branches/b/roles/r",
      ["DATABRICKS_SUPERUSER"],
    );

    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches/b/roles/r",
      method: "PATCH",
      query: { update_mask: "spec.membership_roles" },
      payload: { spec: { membership_roles: ["DATABRICKS_SUPERUSER"] } },
    });
  });

  test("deleteRole: DELETE with reassign_owned_to = the target role's resource name", async () => {
    const fake = client([
      { name: "op", done: false },
      { name: "op", done: true },
    ]);
    await new LakebaseApi(fake, fast).deleteRole(
      "projects/p/branches/b/roles/sp",
      {
        reassignOwnedTo: "projects/p/branches/b/roles/alice",
      },
    );

    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches/b/roles/sp",
      method: "DELETE",
      query: { reassign_owned_to: "projects/p/branches/b/roles/alice" },
    });
    expect(fake.requests[0]?.payload).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
  });
});
