import { ApiError } from "@databricks/sdk-experimental";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchOpenApiSchema } from "../fetcher";

function makeValidSpec(
  paths: Record<string, unknown> = { "/invocations": { post: {} } },
) {
  return {
    openapi: "3.0.0",
    info: { title: "test", version: "1" },
    paths,
  };
}

function createReadableStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

function createMockClient(getOpenApiImpl?: (...args: any[]) => any) {
  const defaultImpl = async () => ({
    contents: createReadableStream(JSON.stringify(makeValidSpec())),
  });
  return {
    servingEndpoints: {
      getOpenApi: vi.fn(getOpenApiImpl ?? defaultImpl),
    },
  } as any;
}

describe("fetchOpenApiSchema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null on ApiError 404", async () => {
    const client = createMockClient(async () => {
      throw new ApiError("Not found", "NOT_FOUND", 404, undefined, []);
    });
    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns null on ApiError 403", async () => {
    const client = createMockClient(async () => {
      throw new ApiError("Forbidden", "FORBIDDEN", 403, undefined, []);
    });
    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns null on ApiError 500", async () => {
    const client = createMockClient(async () => {
      throw new ApiError("Server error", "INTERNAL", 500, undefined, []);
    });
    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns null on generic error", async () => {
    const client = createMockClient(async () => {
      throw new Error("network failure");
    });
    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns null when response has no contents", async () => {
    const client = createMockClient(async () => ({ contents: undefined }));
    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns spec and pathKey for valid response", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/invocations": { post: { requestBody: {} } },
    });
    const client = createMockClient(async () => ({
      contents: createReadableStream(JSON.stringify(spec)),
    }));

    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).not.toBeNull();
    expect(result?.pathKey).toBe("/serving-endpoints/ep/invocations");
    expect(result?.spec.openapi).toBe("3.0.0");
  });

  test("matches servedModel path when provided", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/served-models/gpt4/invocations": { post: {} },
      "/serving-endpoints/ep/invocations": { post: {} },
    });
    const client = createMockClient(async () => ({
      contents: createReadableStream(JSON.stringify(spec)),
    }));

    const result = await fetchOpenApiSchema(client, "ep", "gpt4");
    expect(result?.pathKey).toBe(
      "/serving-endpoints/ep/served-models/gpt4/invocations",
    );
  });

  test("falls back to first path when servedModel not found", async () => {
    const spec = makeValidSpec({
      "/serving-endpoints/ep/invocations": { post: {} },
    });
    const client = createMockClient(async () => ({
      contents: createReadableStream(JSON.stringify(spec)),
    }));

    const result = await fetchOpenApiSchema(client, "ep", "nonexistent-model");
    expect(result?.pathKey).toBe("/serving-endpoints/ep/invocations");
  });

  test("returns null for invalid spec structure (missing paths)", async () => {
    const client = createMockClient(async () => ({
      contents: createReadableStream(
        JSON.stringify({ openapi: "3.0.0", info: {} }),
      ),
    }));

    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("returns null when paths object is empty", async () => {
    const client = createMockClient(async () => ({
      contents: createReadableStream(JSON.stringify(makeValidSpec({}))),
    }));

    const result = await fetchOpenApiSchema(client, "ep");
    expect(result).toBeNull();
  });

  test("calls SDK getOpenApi with correct endpoint name", async () => {
    const client = createMockClient();
    await fetchOpenApiSchema(client, "my-endpoint");

    expect(client.servingEndpoints.getOpenApi).toHaveBeenCalledWith({
      name: "my-endpoint",
    });
  });
});
