import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchOpenApiSchema } from "../fetcher";

const mockAuthenticate = vi.fn(async () => {});

function createMockClient(host?: string) {
  return {
    config: {
      host,
      authenticate: mockAuthenticate,
    },
  } as any;
}

function makeValidSpec(
  paths: Record<string, unknown> = { "/invocations": { post: {} } },
) {
  return {
    openapi: "3.0.0",
    info: { title: "test", version: "1" },
    paths,
  };
}

describe("fetchOpenApiSchema", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeValidSpec()), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null when host is not configured", async () => {
    const result = await fetchOpenApiSchema(createMockClient(undefined), "ep");
    expect(result).toBeNull();
  });

  test("returns null on HTTP 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not found", { status: 404 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my-endpoint",
    );
    expect(result).toBeNull();
  });

  test("returns null on HTTP 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my-endpoint",
    );
    expect(result).toBeNull();
  });

  test("returns null on generic error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server error", { status: 500 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my-endpoint",
    );
    expect(result).toBeNull();
  });

  test("returns null on timeout (AbortError)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my-endpoint",
    );
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my-endpoint",
    );
    expect(result).toBeNull();
  });

  test("returns spec and pathKey for valid response", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/invocations": { post: { requestBody: {} } },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
    );
    expect(result).not.toBeNull();
    expect(result?.pathKey).toBe("/serving-endpoints/ep/invocations");
    expect(result?.spec.openapi).toBe("3.0.0");
  });

  test("matches servedModel path when provided", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/served-models/gpt4/invocations": { post: {} },
      "/serving-endpoints/ep/invocations": { post: {} },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
      "gpt4",
    );
    expect(result?.pathKey).toBe(
      "/serving-endpoints/ep/served-models/gpt4/invocations",
    );
  });

  test("falls back to first path when servedModel not found", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/invocations": { post: {} },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(spec), { status: 200 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
      "nonexistent-model",
    );
    expect(result?.pathKey).toBe("/serving-endpoints/ep/invocations");
  });

  test("returns null for invalid spec structure (missing paths)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ openapi: "3.0.0", info: {} }), {
        status: 200,
      }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
    );
    expect(result).toBeNull();
  });

  test("returns null when paths object is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeValidSpec({})), { status: 200 }),
    );

    const result = await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
    );
    expect(result).toBeNull();
  });

  test("authenticates request headers", async () => {
    await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "ep",
    );
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.any(Headers));
  });

  test("constructs correct URL with encoded endpoint name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await fetchOpenApiSchema(
      createMockClient("https://host.databricks.com"),
      "my endpoint",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/serving-endpoints/my%20endpoint/openapi"),
      expect.any(Object),
    );
  });

  test("prepends https when host lacks protocol", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await fetchOpenApiSchema(createMockClient("host.databricks.com"), "ep");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url.startsWith("https://")).toBe(true);
  });
});
