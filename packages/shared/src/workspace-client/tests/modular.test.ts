import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly.
// Capture the `ClientOptions` the modular `WarehousesClient` constructor receives
// so we can assert how wrapper options map onto the modular SDK's config.
const { ctorOpts, patTokens, m2mOpts, m2mMint, u2mMint, profileState } =
  vi.hoisted(() => ({
    ctorOpts: [] as Array<Record<string, unknown>>,
    patTokens: [] as string[],
    m2mOpts: [] as Array<Record<string, unknown>>,
    // Each M2M `token()` call mints a new token, like the real (uncached) SDK.
    m2mMint: { count: 0, ttlMs: 60 * 60 * 1000 },
    // Each CLI `token()` call is a `databricks auth token` subprocess.
    u2mMint: { count: 0 },
    // What the mocked `~/.databrickscfg` profile resolution returns.
    profileState: {
      profile: {} as Record<string, unknown>,
      resolveCalls: [] as unknown[],
    },
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
    return {
      name: () => "oauth-m2m",
      token: async () => ({
        value: `m2m-token-${++m2mMint.count}`,
        expiry: new Date(Date.now() + m2mMint.ttlMs),
      }),
    };
  }),
  newU2mCredentials: vi.fn(() => ({
    name: () => "databricks-cli",
    token: async () => ({
      value: `cli-token-${++u2mMint.count}`,
      expiry: new Date(Date.now() + 60 * 60 * 1000),
    }),
  })),
  defaultCredentials: vi.fn(() => ({ kind: "sdk-default" })),
}));
vi.mock("@databricks/sdk-core/profiles", () => ({
  resolve: vi.fn(async (opts: unknown) => {
    profileState.resolveCalls.push(opts);
    return profileState.profile;
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
    m2mMint.count = 0;
    m2mMint.ttlMs = 60 * 60 * 1000;
    u2mMint.count = 0;
    profileState.profile = {};
    profileState.resolveCalls.length = 0;
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

  test("no host, no token, no profile, no env → cached SDK default chain", () => {
    buildWarehousesClient({});
    expect(ctorOpts[0].host).toBeUndefined();
    expect((ctorOpts[0].credentials as { name(): string }).name()).toBe(
      "default",
    );
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
    // Wrapped in the token cache, so assert the strategy, not identity.
    expect((ctorOpts[0].credentials as { name(): string }).name()).toBe(
      "oauth-m2m",
    );
    expect(patTokens).toEqual([]);
  });

  test("env M2M: caches the OAuth token until 40s before expiry, then refreshes", async () => {
    // sdk-auth's newM2mCredentials mints a new OAuth token on every request;
    // the legacy SDK reused it until expiry.
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildWarehousesClient({});
    const creds = ctorOpts[0].credentials as {
      authHeaders(): Promise<Array<{ key: string; value: string }>>;
    };
    const bearer = async () =>
      (await creds.authHeaders()).find((h) => h.key === "Authorization")?.value;
    expect(await bearer()).toBe("Bearer m2m-token-1");
    expect(await bearer()).toBe("Bearer m2m-token-1");
    expect(m2mMint.count).toBe(1);

    // A token inside the 40s refresh margin is replaced on the next request.
    m2mMint.ttlMs = 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      expect(await bearer()).toBe("Bearer m2m-token-2");
      expect(await bearer()).toBe("Bearer m2m-token-3");
    } finally {
      vi.useRealTimers();
    }
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
    expect((ctorOpts[0].credentials as { name(): string }).name()).toBe(
      "default",
    );
  });

  describe("default chain (profile / ~/.databrickscfg) token cache", () => {
    const bearerOf = (creds: unknown) => async () =>
      (
        await (
          creds as {
            authHeaders(): Promise<Array<{ key: string; value: string }>>;
          }
        ).authHeaders()
      ).find((h) => h.key === "Authorization")?.value;

    test("CLI profile: 5 calls → one `databricks auth token`, profile resolved once", async () => {
      profileState.profile = { name: "dev", host: "https://ws" };
      buildWarehousesClient({ profile: "dev" });
      const bearer = bearerOf(ctorOpts[0].credentials);
      for (let i = 0; i < 5; i++) {
        expect(await bearer()).toBe("Bearer cli-token-1");
      }
      expect(u2mMint.count).toBe(1);
      expect(profileState.resolveCalls).toEqual([{ profile: "dev" }]);
    });

    test("M2M profile: 5 calls → one OAuth token", async () => {
      profileState.profile = {
        name: "ci",
        host: "ws.cloud.databricks.com/",
        clientId: "id",
        clientSecret: { value: "secret" },
      };
      buildWarehousesClient({ profile: "ci" });
      const bearer = bearerOf(ctorOpts[0].credentials);
      for (let i = 0; i < 5; i++) {
        expect(await bearer()).toBe("Bearer m2m-token-1");
      }
      expect(m2mMint.count).toBe(1);
      expect(m2mOpts).toEqual([
        // Scheme-normalized, trailing slash dropped, like env M2M.
        {
          host: "https://ws.cloud.databricks.com",
          clientId: "id",
          clientSecret: "secret",
        },
      ]);
    });

    test("PAT profile: uses the profile token", async () => {
      profileState.profile = {
        name: "p",
        host: "https://ws",
        token: { value: "profile-pat" },
      };
      buildWarehousesClient({});
      await (ctorOpts[0].credentials as { authHeaders(): Promise<unknown> })
        .authHeaders()
        .catch(() => undefined);
      expect(patTokens).toEqual(["profile-pat"]);
      expect(u2mMint.count).toBe(0);
    });

    test("authType / groupId profiles keep the SDK's own selection", async () => {
      const { defaultCredentials } =
        await import("@databricks/sdk-auth/credentials");
      profileState.profile = {
        name: "g",
        host: "https://ws",
        clientId: "id",
        clientSecret: { value: "s" },
        groupId: "grp",
      };
      buildWarehousesClient({ profile: "g" });
      await (ctorOpts[0].credentials as { authHeaders(): Promise<unknown> })
        .authHeaders()
        .catch(() => undefined);
      expect(defaultCredentials).toHaveBeenCalledWith({
        profile: profileState.profile,
      });
      expect(m2mOpts).toEqual([]);
    });
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
