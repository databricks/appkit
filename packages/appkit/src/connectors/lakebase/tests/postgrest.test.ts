import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfigurationError } from "../../../errors";
import { createLakebasePostgrestClient } from "../postgrest";

const mocks = vi.hoisted(() => ({
  fetchWithToken: vi.fn((_resolveToken: unknown, _fetch?: unknown) => ({
    wrappedFetch: true,
  })),
  NeonPostgrestClient: vi.fn(function MockNeonPostgrestClient(
    this: { config?: unknown },
    config: unknown,
  ) {
    this.config = config;
  }),
}));

vi.mock("@neondatabase/postgrest-js", () => mocks);

describe("createLakebasePostgrestClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.LAKEBASE_DATA_API_URL;
  });

  test("throws an AppKit configuration error when no Data API URL is configured", () => {
    expect(() =>
      createLakebasePostgrestClient({ resolveToken: async () => "tok" }),
    ).toThrow(ConfigurationError);
  });

  test("creates a PostgREST client with token-aware fetch", () => {
    const resolveToken = vi.fn(async () => "tok");
    const fetchSpy = vi.fn();

    const client = createLakebasePostgrestClient({
      dataApiUrl: "https://example.test/rest/v1",
      schema: "custom",
      resolveToken,
      fetch: fetchSpy as unknown as typeof fetch,
    }) as { config: Record<string, unknown> };

    expect(mocks.fetchWithToken).toHaveBeenCalledWith(resolveToken, fetchSpy);
    expect(mocks.NeonPostgrestClient).toHaveBeenCalledTimes(1);
    expect(client.config).toEqual({
      dataApiUrl: "https://example.test/rest/v1",
      options: {
        db: { schema: "custom" },
        global: { fetch: { wrappedFetch: true } },
      },
    });
  });

  test("falls back to LAKEBASE_DATA_API_URL and app schema", () => {
    process.env.LAKEBASE_DATA_API_URL = "https://env.example/rest/v1";

    const client = createLakebasePostgrestClient({
      resolveToken: async () => "tok",
    }) as { config: Record<string, unknown> };

    expect(client.config).toMatchObject({
      dataApiUrl: "https://env.example/rest/v1",
      options: { db: { schema: "app" } },
    });
  });
});
