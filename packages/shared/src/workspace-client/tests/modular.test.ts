import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly.
// Capture the `ClientOptions` the modular `WarehousesClient` constructor receives
// so we can assert how wrapper options map onto the modular SDK's config.
const { ctorOpts, patTokens, m2mOpts } = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  patTokens: [] as string[],
  m2mOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@databricks/sdk-warehouses/v1", () => ({
  WarehousesClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts };
  }),
}));
vi.mock("@databricks/sdk-statementexecution/v1", () => ({
  StatementExecutionClient: vi.fn().mockImplementation((opts) => ({ opts })),
}));
vi.mock("@databricks/sdk-auth/credentials", () => ({
  newPatCredentials: vi.fn((token: string) => {
    patTokens.push(token);
    return { kind: "pat", token };
  }),
  newM2mCredentials: vi.fn((opts: Record<string, unknown>) => {
    m2mOpts.push(opts);
    return { kind: "m2m", ...opts };
  }),
}));
// The default transport: its `send` echoes the final request headers so tests
// can assert the User-Agent the wrapper set before delegating.
vi.mock("@databricks/sdk-core/http", () => ({
  newFetchHttpClient: vi.fn(() => ({
    send: vi.fn((request: { headers: Headers }) =>
      Promise.resolve({
        statusCode: 200,
        headers: request.headers,
        body: null,
      }),
    ),
  })),
}));

import { buildWarehousesClient } from "../modular";

/** Drive the wrapped httpClient with one request and return the UA it set. */
async function sentUserAgent(
  httpClient: unknown,
  seedUserAgent?: string,
): Promise<string | null> {
  const headers = new Headers(
    seedUserAgent ? { "User-Agent": seedUserAgent } : undefined,
  );
  await (
    httpClient as {
      send: (r: {
        url: string;
        method: string;
        headers: Headers;
      }) => Promise<unknown>;
    }
  ).send({ url: "https://x", method: "GET", headers });
  return headers.get("User-Agent");
}

describe("modular mapToClientOptions (via buildWarehousesClient)", () => {
  // Auth resolution reads these env vars; snapshot + clear them so the dev
  // machine's own DATABRICKS_* values never leak into a case.
  const AUTH_ENV = [
    "DATABRICKS_HOST",
    "DATABRICKS_CLIENT_ID",
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    ctorOpts.length = 0;
    patTokens.length = 0;
    m2mOpts.length = 0;
    for (const key of AUTH_ENV) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of AUTH_ENV) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test("prepends https:// to a scheme-less explicit host", () => {
    buildWarehousesClient({ host: "ws.cloud.databricks.com" });
    expect(ctorOpts[0].host).toBe("https://ws.cloud.databricks.com");
  });

  test("leaves an explicit host that already has a scheme unchanged", () => {
    buildWarehousesClient({ host: "https://ws.cloud.databricks.com" });
    expect(ctorOpts[0].host).toBe("https://ws.cloud.databricks.com");
  });

  test("falls back to DATABRICKS_HOST (scheme-normalized) when no host is passed", () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    buildWarehousesClient({});
    expect(ctorOpts[0].host).toBe("https://envhost.cloud.databricks.com");
  });

  test("a token takes the PAT path and pins the resolved host", () => {
    buildWarehousesClient({ token: "abc", host: "https://x" });
    expect(patTokens).toEqual(["abc"]);
    expect(ctorOpts[0].host).toBe("https://x");
    expect(ctorOpts[0].credentials).toEqual({ kind: "pat", token: "abc" });
  });

  test("an empty-string token still uses PAT (no silent fall-through to default auth)", () => {
    buildWarehousesClient({ token: "", host: "https://x" });
    expect(patTokens).toEqual([""]);
    expect(ctorOpts[0].credentials).toEqual({ kind: "pat", token: "" });
  });

  test("a profile sets profileOptions and defers host to the SDK (ignores env)", () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    buildWarehousesClient({ profile: "myprofile" });
    expect(ctorOpts[0].profileOptions).toEqual({ profile: "myprofile" });
    expect(ctorOpts[0].host).toBeUndefined();
    expect(patTokens).toEqual([]);
  });

  test("no host, no token, no profile, no env → empty options (SDK default chain)", () => {
    buildWarehousesClient({});
    expect(ctorOpts[0].host).toBeUndefined();
    expect(ctorOpts[0].credentials).toBeUndefined();
    expect(ctorOpts[0].profileOptions).toBeUndefined();
  });

  test("service-principal by default: DATABRICKS_CLIENT_ID/SECRET + host env → M2M creds", () => {
    // The Databricks Apps runtime injects the app's SP credentials via env. The
    // SDK's default chain would read them too, but its M2M strategy uses the raw
    // scheme-less DATABRICKS_HOST for OAuth discovery (→ Invalid URL); we resolve
    // M2M here with the scheme-normalized host so discovery succeeds.
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildWarehousesClient({});
    expect(m2mOpts).toEqual([
      {
        host: "https://envhost.cloud.databricks.com",
        clientId: "sp-client-id",
        clientSecret: "sp-secret",
      },
    ]);
    expect(ctorOpts[0].credentials).toEqual({
      kind: "m2m",
      host: "https://envhost.cloud.databricks.com",
      clientId: "sp-client-id",
      clientSecret: "sp-secret",
    });
    expect(patTokens).toEqual([]);
  });

  test("falls back to DATABRICKS_TOKEN (PAT) when no client id/secret is set", () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_TOKEN = "env-pat";
    buildWarehousesClient({});
    expect(patTokens).toEqual(["env-pat"]);
    expect(ctorOpts[0].credentials).toEqual({ kind: "pat", token: "env-pat" });
    expect(m2mOpts).toEqual([]);
  });

  test("an explicit (OBO) token wins over env SP credentials — no escalation", () => {
    // asUser passes the user's token; it must NOT be shadowed by the SP env
    // creds the deployed runtime also sets.
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildWarehousesClient({ token: "user-token", host: "https://x" });
    expect(patTokens).toEqual(["user-token"]);
    expect(ctorOpts[0].credentials).toEqual({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("M2M needs a host: client id/secret with no resolvable host falls through to the default chain", () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildWarehousesClient({});
    expect(m2mOpts).toEqual([]);
    expect(ctorOpts[0].credentials).toBeUndefined();
  });

  test("User-Agent: prepends the exact @databricks/appkit product segment (dashboards match on it)", async () => {
    // Regression: the modular SDK's `setProduct` rejects `@databricks/appkit`
    // (the `@`/`/`). We set the UA on the httpClient transport instead, keeping
    // the literal legacy product string that Databricks-side dashboards match.
    buildWarehousesClient({
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
        userAgentExtra: { mode: "dev" },
      },
    } as never);
    // The SDK's own client-info UA is already on the request; ours prepends.
    const ua = await sentUserAgent(ctorOpts[0].httpClient, "sdk-js-core/1.0.0");
    expect(ua).toBe("@databricks/appkit/0.64.0 mode/dev sdk-js-core/1.0.0");
  });

  test("User-Agent: sets the product segment even when the request has no prior UA", async () => {
    buildWarehousesClient({
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
      },
    } as never);
    const ua = await sentUserAgent(ctorOpts[0].httpClient);
    expect(ua).toBe("@databricks/appkit/0.64.0");
  });

  test("no product configured (build-time) → no httpClient override (SDK default UA)", () => {
    buildWarehousesClient({ host: "https://x" });
    expect(ctorOpts[0].httpClient).toBeUndefined();
  });
});
