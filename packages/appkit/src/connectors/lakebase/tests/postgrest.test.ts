import { afterEach, describe, expect, test } from "vitest";
import { ConfigurationError } from "../../../errors";
import { createLakebasePostgrestClient } from "../postgrest";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h =
        init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    calls.push({ url: String(input), headers });
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

interface PostgrestClient {
  from(table: string): {
    select(): Promise<unknown>;
  };
}

describe("createLakebasePostgrestClient", () => {
  afterEach(() => {
    delete process.env.LAKEBASE_DATA_API_URL;
  });

  test("throws when no Data API URL is configured", () => {
    expect(() =>
      createLakebasePostgrestClient({ resolveToken: async () => "tok" }),
    ).toThrow(ConfigurationError);
  });

  test("issues PostgREST requests against the configured dataApiUrl with token + schema headers", async () => {
    const { fetch: recording, calls } = recordingFetch();

    const client = createLakebasePostgrestClient({
      dataApiUrl: "https://example.test/rest/v1",
      schema: "custom",
      resolveToken: async () => "tok-abc",
      fetch: recording,
    }) as PostgrestClient;

    await client.from("widgets").select();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toContain("https://example.test/rest/v1/widgets");
    expect(call.headers.authorization).toBe("Bearer tok-abc");
    expect(call.headers["accept-profile"]).toBe("custom");
  });

  test("falls back to LAKEBASE_DATA_API_URL and the app schema", async () => {
    process.env.LAKEBASE_DATA_API_URL = "https://env.example/rest/v1";
    const { fetch: recording, calls } = recordingFetch();

    const client = createLakebasePostgrestClient({
      resolveToken: async () => "tok",
      fetch: recording,
    }) as PostgrestClient;

    await client.from("widgets").select();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://env.example/rest/v1/widgets");
    expect(calls[0].headers["accept-profile"]).toBe("app");
  });

  test("a null token surfaces as AuthRequiredError without firing fetch", async () => {
    const { fetch: recording, calls } = recordingFetch();

    const client = createLakebasePostgrestClient({
      dataApiUrl: "https://example.test/rest/v1",
      resolveToken: async () => null,
      fetch: recording,
    }) as PostgrestClient;

    const result = (await client.from("widgets").select()) as {
      error: { message: string } | null;
    };

    expect(calls).toHaveLength(0);
    expect(result.error?.message).toMatch(/AuthRequiredError/);
  });
});
