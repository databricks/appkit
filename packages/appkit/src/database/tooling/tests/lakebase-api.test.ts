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
    const api = new LakebaseApi(fake);

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
});
