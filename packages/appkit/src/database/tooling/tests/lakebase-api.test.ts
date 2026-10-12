import { describe, expect, test } from "vitest";

import type { ToolingRequest } from "../context";
import { LakebaseApi, LakebaseApiError } from "../lakebase-api";

type Reply = unknown | ((request: ToolingRequest) => unknown);

/** apiClient fake: replies in order, records each request. */
function client(replies: Reply[]) {
  const requests: ToolingRequest[] = [];
  return {
    requests,
    apiClient: {
      async request(request: ToolingRequest) {
        requests.push(request);
        if (replies.length === 0)
          throw new Error(
            `unexpected request ${request.method} ${request.path}`,
          );
        const reply = replies.shift();
        const value =
          typeof reply === "function"
            ? (reply as (r: ToolingRequest) => unknown)(request)
            : reply;
        if (value instanceof Error) throw value;
        return value;
      },
    },
  };
}

const apiError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode, errorCode: "X" });

const fast = { pollIntervalMs: 1 };

describe("LakebaseApi", () => {
  test("getBranch: GET /api/2.0/postgres/{name}; 404 → null; other errors keep their status", async () => {
    const fake = client([
      { name: "projects/p/branches/b" },
      apiError(404, "NOT_FOUND"),
      apiError(403, "PERMISSION_DENIED"),
    ]);
    const api = new LakebaseApi(fake, fast);

    await expect(api.getBranch("projects/p/branches/b")).resolves.toEqual({
      name: "projects/p/branches/b",
    });
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
      raw: false,
    });
    expect(fake.requests[0]?.headers.get("Accept")).toBe("application/json");
    expect(fake.requests[0]?.headers.get("Content-Type")).toBeNull();
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
    );

    expect(endpoint.name).toBe("projects/p/branches/b/endpoints/primary");
    expect(fake.requests[0]).toMatchObject({
      path: "/api/2.0/postgres/projects/p/branches/b/endpoints",
      method: "POST",
      query: { endpoint_id: "primary" },
      payload: { spec: { endpoint_type: "ENDPOINT_TYPE_READ_WRITE" } },
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
      ),
    ).rejects.toThrow(/timed out/);
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
