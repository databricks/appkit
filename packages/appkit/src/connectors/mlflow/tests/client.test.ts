import { afterEach, describe, expect, test, vi } from "vitest";
import { MlflowClient, normalizeHost } from "../client";

describe("normalizeHost", () => {
  test("adds https:// when missing and strips trailing slashes", () => {
    expect(normalizeHost("workspace.cloud.databricks.com")).toBe(
      "https://workspace.cloud.databricks.com",
    );
    expect(normalizeHost("https://host.com/")).toBe("https://host.com");
    expect(normalizeHost("http://host.com//")).toBe("http://host.com");
  });
});

describe("MlflowClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("normalizes host once and derives the serving-endpoints URL", () => {
    const client = new MlflowClient("host.databricks.com", "tok");
    expect(client.baseUrl).toBe("https://host.databricks.com");
    expect(client.servingEndpointsUrl()).toBe(
      "https://host.databricks.com/serving-endpoints",
    );
  });

  test("post() sends bearer auth to the normalized URL and parses JSON", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: 1 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new MlflowClient("host.com", "secret");
    const body = await client.post("/api/2.0/mlflow/runs/create", { a: 1 });

    expect(body).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://host.com/api/2.0/mlflow/runs/create");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  test("post() throws with status + body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 400 })),
    );
    const client = new MlflowClient("host.com", "t");
    await expect(client.post("/p", {})).rejects.toThrow(/400 boom/);
  });

  test("postResult() returns a structured failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    const client = new MlflowClient("host.com", "t");
    expect(await client.postResult("/p", {})).toEqual({
      ok: false,
      status: 403,
      error: "nope",
    });
  });

  test("postResult() reports ok on success and network errors without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MlflowClient("host.com", "t");
    expect(await client.postResult("/p", {})).toEqual({ ok: true });
    expect(await client.postResult("/p", {})).toEqual({
      ok: false,
      error: "ECONNREFUSED",
    });
  });
});
