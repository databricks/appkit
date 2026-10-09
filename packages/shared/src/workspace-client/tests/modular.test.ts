import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly.
// Capture the `ClientOptions` the modular `WarehousesClient` constructor receives
// so we can assert how wrapper options map onto the modular SDK's config.
const {
  ctorOpts,
  patTokens,
  m2mOpts,
  m2mToken,
  resolveProfile,
  defaultCreds,
  sent,
  nextResponse,
} = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  patTokens: [] as string[],
  m2mOpts: [] as Array<Record<string, unknown>>,
  // Each M2M `token()` call mints a new token, like the real SDK's (uncached).
  m2mToken: vi.fn(),
  resolveProfile: vi.fn(),
  defaultCreds: vi.fn(),
  sent: [] as Array<{ url: string; method: string; headers: Headers }>,
  nextResponse: { statusCode: 200, body: "{}" },
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
vi.mock("@databricks/sdk-genie/v1", () => ({
  GenieClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts };
  }),
}));
vi.mock("@databricks/sdk-auth/credentials", () => ({
  newPatCredentials: vi.fn((token: string) => {
    patTokens.push(token);
    return {
      kind: "pat",
      token,
      authHeaders: async () => [
        { key: "Authorization", value: `Bearer ${token}` },
      ],
    };
  }),
  newM2mCredentials: vi.fn((opts: Record<string, unknown>) => {
    m2mOpts.push(opts);
    return { name: () => "oauth-m2m", token: m2mToken };
  }),
  defaultCredentials: defaultCreds,
}));
vi.mock("@databricks/sdk-core/profiles", () => ({ resolve: resolveProfile }));
// The default transport: records each request and echoes its final headers so
// tests can assert the User-Agent / auth the wrapper set before delegating.
vi.mock("@databricks/sdk-core/http", () => ({
  newFetchHttpClient: vi.fn(() => ({
    send: vi.fn(
      (request: { url: string; method: string; headers: Headers }) => {
        sent.push(request);
        return Promise.resolve({
          statusCode: nextResponse.statusCode,
          headers: request.headers,
          body: new Response(nextResponse.body).body,
        });
      },
    ),
  })),
}));

import { ApiError } from "../errors";
import {
  buildGenieClient,
  buildWarehousesClient,
  buildWorkspaceAuth,
} from "../modular";

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
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "abc",
    });
  });

  test("an empty-string token still uses PAT (no silent fall-through to default auth)", () => {
    buildWarehousesClient({ token: "", host: "https://x" });
    expect(patTokens).toEqual([""]);
    expect(ctorOpts[0].credentials).toMatchObject({ kind: "pat", token: "" });
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
    // Wrapped in the token cache, so assert the strategy, not identity.
    expect((ctorOpts[0].credentials as { name: () => string }).name()).toBe(
      "oauth-m2m",
    );
    expect(patTokens).toEqual([]);
  });

  test("falls back to DATABRICKS_TOKEN (PAT) when no client id/secret is set", () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_TOKEN = "env-pat";
    buildWarehousesClient({});
    expect(patTokens).toEqual(["env-pat"]);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "env-pat",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("an explicit (OBO) token wins over env SP credentials — no escalation", () => {
    // asUser passes the user's token; it must NOT be shadowed by the SP env
    // creds the deployed runtime also sets.
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildWarehousesClient({ token: "user-token", host: "https://x" });
    expect(patTokens).toEqual(["user-token"]);
    expect(ctorOpts[0].credentials).toMatchObject({
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

  test("genie (asUser) uses the OBO token as PAT and keeps the AppKit User-Agent", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    buildGenieClient({
      token: "user-token",
      host: "https://x",
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
      },
    } as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
    expect(await sentUserAgent(ctorOpts[0].httpClient)).toBe(
      "@databricks/appkit/0.64.0",
    );
  });

  test("no product configured (build-time) → no httpClient override (SDK default UA)", () => {
    buildWarehousesClient({ host: "https://x" });
    expect(ctorOpts[0].httpClient).toBeUndefined();
  });
});

describe("buildWorkspaceAuth (auth + raw-request seam)", () => {
  const AUTH_ENV = [
    "DATABRICKS_HOST",
    "DATABRICKS_CLIENT_ID",
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};
  const hour = 3_600_000;

  beforeEach(() => {
    patTokens.length = 0;
    m2mOpts.length = 0;
    sent.length = 0;
    nextResponse.statusCode = 200;
    nextResponse.body = "{}";
    let n = 0;
    m2mToken.mockReset().mockImplementation(async () => ({
      value: `m2m-${++n}`,
      expiry: new Date(Date.now() + hour),
    }));
    // Never read the dev machine's ~/.databrickscfg.
    resolveProfile.mockReset().mockResolvedValue({});
    defaultCreds.mockReset().mockReturnValue({
      authHeaders: async () => [{ key: "Authorization", value: "Bearer dflt" }],
    });
    for (const key of AUTH_ENV) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of AUTH_ENV) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  async function authHeader(auth: ReturnType<typeof buildWorkspaceAuth>) {
    const headers = new Headers();
    await auth.authenticate(headers);
    return headers.get("Authorization");
  }

  test("an OBO token wins over env SP credentials — no escalation", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    const auth = buildWorkspaceAuth({ token: "user-token", host: "https://x" });
    expect(await authHeader(auth)).toBe("Bearer user-token");
    expect(await auth.getHost()).toBe("https://x");
    expect(m2mOpts).toEqual([]);
    expect(defaultCreds).not.toHaveBeenCalled();
  });

  test("an empty OBO token stays on PAT — never falls through to SP or the default chain", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    const auth = buildWorkspaceAuth({ token: "" });
    // `Headers` trims the trailing space of "Bearer ".
    expect(await authHeader(auth)).toBe("Bearer");
    expect(patTokens).toEqual([""]);
    expect(m2mOpts).toEqual([]);
    expect(defaultCreds).not.toHaveBeenCalled();
  });

  test("a profile resolves host + credentials through the SDK profile resolver", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    resolveProfile.mockResolvedValue({
      host: "prof.cloud.databricks.com/",
      token: "p",
    });
    const auth = buildWorkspaceAuth({ profile: "myprofile" });
    // Profile host wins over env, scheme-normalized, trailing slash dropped.
    expect(await auth.getHost()).toBe("https://prof.cloud.databricks.com");
    expect(await authHeader(auth)).toBe("Bearer dflt");
    expect(resolveProfile).toHaveBeenCalledWith({ profile: "myprofile" });
    expect(defaultCreds).toHaveBeenCalledWith({
      profile: { host: "https://prof.cloud.databricks.com", token: "p" },
    });
    // Resolved once and memoized.
    await auth.getHost();
    expect(resolveProfile).toHaveBeenCalledTimes(1);
  });

  test("a failed resolution is retried instead of cached", async () => {
    resolveProfile.mockRejectedValueOnce(new Error("bad cfg"));
    const auth = buildWorkspaceAuth({ profile: "p", host: "https://x" });
    await expect(auth.getHost()).rejects.toThrow("bad cfg");
    expect(await auth.getHost()).toBe("https://x");
  });

  test("no host anywhere → fails loudly", async () => {
    await expect(buildWorkspaceAuth({}).getHost()).rejects.toThrow(
      "Host is required.",
    );
  });

  test("env M2M: authenticates as the SP with the scheme-normalized host", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    const auth = buildWorkspaceAuth({});
    expect(await auth.getHost()).toBe("https://envhost.cloud.databricks.com");
    expect(await authHeader(auth)).toBe("Bearer m2m-1");
    expect(m2mOpts[0].host).toBe("https://envhost.cloud.databricks.com");
    expect(defaultCreds).not.toHaveBeenCalled();
  });

  test("env M2M: caches the OAuth token until 40s before expiry, then refreshes", async () => {
    // Regression: sdk-auth's newM2mCredentials mints a new token on EVERY
    // call; the legacy SDK reused it until expiry.
    vi.useFakeTimers();
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    const auth = buildWorkspaceAuth({});

    // Concurrent first calls share one fetch.
    const [a, b] = await Promise.all([authHeader(auth), authHeader(auth)]);
    expect([a, b]).toEqual(["Bearer m2m-1", "Bearer m2m-1"]);
    vi.advanceTimersByTime(hour - 41_000);
    expect(await authHeader(auth)).toBe("Bearer m2m-1");
    expect(m2mToken).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // now inside the 40s refresh margin
    expect(await authHeader(auth)).toBe("Bearer m2m-2");
    expect(m2mToken).toHaveBeenCalledTimes(2);
  });

  test("env M2M: a failed token fetch is not cached", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    m2mToken.mockRejectedValueOnce(new Error("token endpoint down"));
    const auth = buildWorkspaceAuth({});
    await expect(authHeader(auth)).rejects.toThrow("token endpoint down");
    expect(await authHeader(auth)).toBe("Bearer m2m-1");
  });

  test("request: sends through the transport with the AppKit User-Agent, auth, and query", async () => {
    const auth = buildWorkspaceAuth({
      host: "ws.cloud.databricks.com",
      token: "t",
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
      },
    } as never);
    nextResponse.body = '{"warehouses":[]}';
    const res = await auth.request({
      method: "GET",
      path: "/api/2.0/sql/warehouses",
      query: { skip_cannot_use: "true" },
      headers: { "X-Extra": "1" },
    });
    expect(await res.json()).toEqual({ warehouses: [] });
    expect(sent[0].url).toBe(
      "https://ws.cloud.databricks.com/api/2.0/sql/warehouses?skip_cannot_use=true",
    );
    expect(sent[0].method).toBe("GET");
    expect(sent[0].headers.get("User-Agent")).toBe("@databricks/appkit/0.64.0");
    expect(sent[0].headers.get("Authorization")).toBe("Bearer t");
    expect(sent[0].headers.get("X-Extra")).toBe("1");
  });

  test("request: a non-2xx status throws the wrapper ApiError with code + status", async () => {
    nextResponse.statusCode = 403;
    nextResponse.body = '{"error_code":"PERMISSION_DENIED","message":"nope"}';
    const auth = buildWorkspaceAuth({ host: "https://x", token: "t" });
    const error = await auth
      .request({ method: "GET", path: "/api/x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "nope",
      errorCode: "PERMISSION_DENIED",
      statusCode: 403,
    });
  });
});
