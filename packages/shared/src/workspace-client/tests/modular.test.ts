import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly.
// Capture the `ClientOptions` the modular `WarehousesClient` constructor receives
// so we can assert how wrapper options map onto the modular SDK's config.
const {
  ctorOpts,
  patTokens,
  m2mOpts,
  m2mToken,
  u2mMint,
  resolveProfile,
  defaultCreds,
  sent,
  nextResponse,
  cliCalls,
  responses,
} = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  patTokens: [] as string[],
  m2mOpts: [] as Array<Record<string, unknown>>,
  // Each M2M `token()` call mints a new token, like the real SDK's (uncached).
  m2mToken: vi.fn(),
  // Each CLI `token()` call is a `databricks auth token` subprocess.
  u2mMint: { count: 0 },
  resolveProfile: vi.fn(),
  defaultCreds: vi.fn(),
  sent: [] as Array<{ url: string; method: string; headers: Headers }>,
  nextResponse: { statusCode: 200, body: "{}" },
  // Each `databricks auth token --host` subprocess run by the host CLI path.
  cliCalls: [] as string[][],
  // Queued transport responses, consumed before `nextResponse`.
  responses: [] as Array<{ statusCode: number; body: string }>,
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
    return {
      opts,
      genieGetConversationMessage: async () => ({ id: "m" }),
      async *listItemsIter() {
        yield 1;
        yield 2;
      },
    };
  }),
}));
vi.mock("@databricks/sdk-modelserving/v1", () => ({
  ModelServingClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getInferenceEndpoint: async () => ({}) };
  }),
}));
vi.mock("@databricks/sdk-uc-volumes/v1", () => ({
  VolumesClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getVolume: async () => ({}) };
  }),
}));
vi.mock("@databricks/sdk-uc-functions/v1", () => ({
  FunctionsClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getFunction: async () => ({}) };
  }),
}));
vi.mock("@databricks/sdk-uc-connections/v1", () => ({
  ConnectionsClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getConnection: async () => ({}) };
  }),
}));
vi.mock("@databricks/sdk-database/v1", () => ({
  DatabaseClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getDatabaseInstance: async () => ({}) };
  }),
}));
vi.mock("@databricks/sdk-postgres/v1", () => ({
  PostgresClient: vi.fn().mockImplementation((opts) => {
    ctorOpts.push(opts);
    return { opts, getEndpoint: async () => ({}) };
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
  newU2mCredentials: vi.fn(() => ({
    name: () => "databricks-cli",
    token: async () => ({
      value: `cli-token-${++u2mMint.count}`,
      expiry: new Date(Date.now() + 60 * 60 * 1000),
    }),
  })),
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
        const next = responses.shift() ?? nextResponse;
        return Promise.resolve({
          statusCode: next.statusCode,
          headers: request.headers,
          body: new Response(next.body).body,
        });
      },
    ),
  })),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      cb: (err: null, out: { stdout: string }) => void,
    ) => {
      cliCalls.push(args);
      cb(null, {
        stdout: JSON.stringify({
          access_token: `host-cli-token-${cliCalls.length}`,
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });
    },
  ),
}));

import { ApiError } from "../errors";
import {
  buildFunctionsClient,
  buildConnectionsClient,
  buildDatabaseClient,
  buildGenieClient,
  buildModelServingClient,
  buildVolumesClient,
  buildWarehousesClient,
  buildPostgresClient,
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
    "DATABRICKS_AUTH_TYPE",
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
    expect((ctorOpts[0].credentials as { name(): string }).name()).toBe(
      "default",
    );
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
    await buildGenieClient({
      token: "user-token",
      host: "https://x",
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
      },
    } as never).genieGetConversationMessage({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
    expect(await sentUserAgent(ctorOpts[0].httpClient)).toBe(
      "@databricks/appkit/0.64.0",
    );
  });

  test("lazy clients load the SDK module on first call and build once", async () => {
    const client = buildGenieClient({ host: "https://x" });
    expect(ctorOpts).toEqual([]);
    await expect(
      client.genieGetConversationMessage({} as never),
    ).resolves.toEqual({ id: "m" });
    const items: unknown[] = [];
    for await (const item of (
      client as unknown as { listItemsIter(): AsyncIterable<unknown> }
    ).listItemsIter()) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
    expect(ctorOpts).toHaveLength(1);
    expect(Reflect.get(client, "then")).toBeUndefined();
  });

  test("database maps host normalization + SP M2M credentials through mapToClientOptions", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildDatabaseClient({
      host: "ws.cloud.databricks.com",
    }).getDatabaseInstance({} as never);
    expect(ctorOpts[0].host).toBe("https://ws.cloud.databricks.com");
    expect(m2mOpts[0]).toMatchObject({
      host: "https://ws.cloud.databricks.com",
      clientId: "sp-client-id",
      clientSecret: "sp-secret",
    });
  });

  test("database (asUser) uses the OBO token as PAT and keeps the AppKit User-Agent", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildDatabaseClient({
      token: "user-token",
      host: "https://x",
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
      },
    } as never).getDatabaseInstance({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
    expect(await sentUserAgent(ctorOpts[0].httpClient)).toBe(
      "@databricks/appkit/0.64.0",
    );
  });

  test("modelServing normalizes the host and passes SP M2M credentials", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildModelServingClient({}).getInferenceEndpoint({} as never);
    expect(ctorOpts[0].host).toBe("https://envhost.cloud.databricks.com");
    expect((ctorOpts[0].credentials as { name: () => string }).name()).toBe(
      "oauth-m2m",
    );
  });

  test("modelServing (asUser) uses the OBO token as PAT, not the SP env creds", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildModelServingClient({
      token: "user-token",
      host: "https://x",
    }).getInferenceEndpoint({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("volumes: SP env creds → M2M with the scheme-normalized host", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildVolumesClient({}).getVolume({} as never);
    expect(ctorOpts[0].host).toBe("https://envhost.cloud.databricks.com");
    expect(m2mOpts).toEqual([
      {
        host: "https://envhost.cloud.databricks.com",
        clientId: "sp-client-id",
        clientSecret: "sp-secret",
      },
    ]);
    expect((ctorOpts[0].credentials as { name: () => string }).name()).toBe(
      "oauth-m2m",
    );
  });

  test("volumes (asUser) uses the OBO token as PAT", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildVolumesClient({
      token: "user-token",
      host: "https://x",
    }).getVolume({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("functions maps host + SP M2M credentials onto the client", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildFunctionsClient({
      host: "my-ws.cloud.databricks.com",
    } as never).getFunction({} as never);
    expect(ctorOpts[0].host).toBe("https://my-ws.cloud.databricks.com");
    expect(ctorOpts[0].credentials).toMatchObject({
      name: expect.any(Function),
    });
    expect(m2mOpts).toHaveLength(1);
  });

  test("functions (asUser) uses the OBO token as PAT", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildFunctionsClient({
      token: "user-token",
      host: "https://x",
    } as never).getFunction({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("connections normalizes a scheme-less host and uses SP M2M creds", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildConnectionsClient({
      host: "my-ws.cloud.databricks.com",
    }).getConnection({} as never);
    expect(ctorOpts[0].host).toBe("https://my-ws.cloud.databricks.com");
    expect(m2mOpts).toHaveLength(1);
    expect(patTokens).toEqual([]);
  });

  test("connections (asUser) uses the OBO token as PAT", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildConnectionsClient({
      token: "user-token",
      host: "https://x",
    }).getConnection({} as never);
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("postgres normalizes the host and passes SP M2M credentials", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildPostgresClient({}).getEndpoint({ name: "e" });
    expect(ctorOpts[0].host).toBe("https://envhost.cloud.databricks.com");
    expect((ctorOpts[0].credentials as { name: () => string }).name()).toBe(
      "oauth-m2m",
    );
  });

  test("postgres (asUser) uses the OBO token as PAT, not the SP env creds", async () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    await buildPostgresClient({
      token: "user-token",
      host: "https://x",
    }).getEndpoint({
      name: "e",
    });
    expect(ctorOpts[0].credentials).toMatchObject({
      kind: "pat",
      token: "user-token",
    });
    expect(m2mOpts).toEqual([]);
  });

  test("no product configured (build-time) → transport adds no AppKit User-Agent", async () => {
    buildWarehousesClient({ host: "https://x" });
    expect(await sentUserAgent(ctorOpts[0].httpClient)).toBeNull();
  });
});

describe("buildWorkspaceAuth (auth + raw-request seam)", () => {
  const AUTH_ENV = [
    "DATABRICKS_HOST",
    "DATABRICKS_CLIENT_ID",
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
    "DATABRICKS_AUTH_TYPE",
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
      token: { value: "p" },
    });
    const auth = buildWorkspaceAuth({ profile: "myprofile" });
    // Profile host wins over env, scheme-normalized, trailing slash dropped.
    expect(await auth.getHost()).toBe("https://prof.cloud.databricks.com");
    // The profile PAT, via the cached default chain (not the SDK's own chain).
    expect(await authHeader(auth)).toBe("Bearer p");
    expect(patTokens).toEqual(["p"]);
    expect(defaultCreds).not.toHaveBeenCalled();
    // Host and credentials each resolve the profile once, then memoize.
    await auth.getHost();
    await authHeader(auth);
    expect(resolveProfile).toHaveBeenCalledTimes(2);
    expect(resolveProfile).toHaveBeenCalledWith({ profile: "myprofile" });
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
      headers: new Headers({ "X-Extra": "1" }),
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

  // Same message/code as the legacy SDK's parseErrorFromResponse, which the
  // serving plugin surfaces verbatim in its 502 body.
  test.each([
    [
      "plain text",
      "rate limited",
      "Response from server (Bad Request) rate limited",
    ],
    [
      "non-standard JSON",
      '{"error":"bad"}',
      'Response from server (Bad Request) {"error":"bad"}',
    ],
    ["HTML <pre>", "<html><pre>Bad thing.  </pre></html>", "Bad thing"],
  ])(
    "request: a %s error body keeps the legacy message",
    async (_l, body, message) => {
      nextResponse.statusCode = 400;
      nextResponse.body = body;
      const auth = buildWorkspaceAuth({ host: "https://x", token: "t" });
      const error = await auth
        .request({ method: "GET", path: "/api/x" })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ message, statusCode: 400 });
    },
  );
});

describe("default chain (profile / ~/.databrickscfg) token cache", () => {
  beforeEach(() => {
    ctorOpts.length = 0;
    patTokens.length = 0;
    m2mOpts.length = 0;
    u2mMint.count = 0;
    let n = 0;
    m2mToken.mockReset().mockImplementation(async () => ({
      value: `m2m-${++n}`,
      expiry: new Date(Date.now() + 3_600_000),
    }));
    resolveProfile.mockReset().mockResolvedValue({});
    defaultCreds.mockReset().mockReturnValue({
      authHeaders: async () => [{ key: "Authorization", value: "Bearer dflt" }],
    });
  });

  const bearerOf = (creds: unknown) => async () =>
    (
      await (
        creds as {
          authHeaders(): Promise<Array<{ key: string; value: string }>>;
        }
      ).authHeaders()
    ).find((h) => h.key === "Authorization")?.value;

  test("CLI profile: 5 calls → one `databricks auth token`, profile resolved once", async () => {
    resolveProfile.mockResolvedValue({ name: "dev", host: "https://ws" });
    buildWarehousesClient({ profile: "dev" });
    const bearer = bearerOf(ctorOpts[0].credentials);
    for (let i = 0; i < 5; i++) {
      expect(await bearer()).toBe("Bearer cli-token-1");
    }
    expect(u2mMint.count).toBe(1);
    expect(resolveProfile).toHaveBeenCalledTimes(1);
  });

  test("M2M profile: 5 calls → one OAuth token, host scheme-normalized", async () => {
    resolveProfile.mockResolvedValue({
      name: "ci",
      host: "ws.cloud.databricks.com/",
      clientId: "id",
      clientSecret: { value: "secret" },
    });
    buildWarehousesClient({ profile: "ci" });
    const bearer = bearerOf(ctorOpts[0].credentials);
    for (let i = 0; i < 5; i++) {
      expect(await bearer()).toBe("Bearer m2m-1");
    }
    expect(m2mToken).toHaveBeenCalledTimes(1);
    expect(m2mOpts).toEqual([
      {
        host: "https://ws.cloud.databricks.com",
        clientId: "id",
        clientSecret: "secret",
      },
    ]);
  });

  test("auth_type = databricks-cli (what `databricks auth login` writes) is cached", async () => {
    // A PAT in the same profile must not win over the pinned CLI strategy.
    resolveProfile.mockResolvedValue({
      name: "dev",
      host: "https://ws",
      authType: "databricks-cli",
      token: { value: "stale-pat" },
    });
    buildWarehousesClient({ profile: "dev" });
    const bearer = bearerOf(ctorOpts[0].credentials);
    for (let i = 0; i < 5; i++) {
      expect(await bearer()).toBe("Bearer cli-token-1");
    }
    expect(u2mMint.count).toBe(1);
    expect(patTokens).toEqual([]);
  });

  test("auth_type = oauth-m2m is cached", async () => {
    resolveProfile.mockResolvedValue({
      name: "ci",
      host: "https://ws",
      authType: "oauth-m2m",
      clientId: "id",
      clientSecret: { value: "secret" },
    });
    buildWarehousesClient({ profile: "ci" });
    const bearer = bearerOf(ctorOpts[0].credentials);
    expect(await bearer()).toBe("Bearer m2m-1");
    expect(await bearer()).toBe("Bearer m2m-1");
    expect(m2mToken).toHaveBeenCalledTimes(1);
  });

  test("other auth types and groupId profiles keep the SDK's own selection", async () => {
    for (const extra of [{ authType: "azure-cli" }, { groupId: "grp" }]) {
      const profile = {
        name: "g",
        host: "https://ws",
        clientId: "id",
        clientSecret: { value: "s" },
        ...extra,
      };
      resolveProfile.mockResolvedValue(profile);
      ctorOpts.length = 0;
      buildWarehousesClient({ profile: "g" });
      expect(await bearerOf(ctorOpts[0].credentials)()).toBe("Bearer dflt");
      expect(defaultCreds).toHaveBeenLastCalledWith({ profile });
    }
    expect(m2mOpts).toEqual([]);
  });
});

describe("migration review fixes (host-only auth, DATABRICKS_AUTH_TYPE, retries, ApiError)", () => {
  const ENV = [
    "DATABRICKS_HOST",
    "DATABRICKS_CLIENT_ID",
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
    "DATABRICKS_AUTH_TYPE",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    ctorOpts.length = 0;
    patTokens.length = 0;
    m2mOpts.length = 0;
    cliCalls.length = 0;
    responses.length = 0;
    sent.length = 0;
    nextResponse.statusCode = 200;
    nextResponse.body = "{}";
    resolveProfile.mockReset().mockResolvedValue({
      name: "DEFAULT",
      host: "https://other-workspace",
      token: { value: "default-profile-pat" },
    });
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const bearer = async (creds: unknown) =>
    (
      await (
        creds as {
          authHeaders(): Promise<Array<{ key: string; value: string }>>;
        }
      ).authHeaders()
    ).find((h) => h.key === "Authorization")?.value;

  test("host-only env never uses another host's [DEFAULT] profile; uses the CLI for that host, cached", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    buildWarehousesClient({});
    for (let i = 0; i < 3; i++) {
      expect(await bearer(ctorOpts[0].credentials)).toBe(
        "Bearer host-cli-token-1",
      );
    }
    expect(cliCalls).toEqual([
      ["auth", "token", "--host", "https://envhost.cloud.databricks.com"],
    ]);
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(patTokens).toEqual([]);
  });

  test("DATABRICKS_AUTH_TYPE=pat wins over SP client id/secret", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    process.env.DATABRICKS_TOKEN = "user-pat";
    process.env.DATABRICKS_AUTH_TYPE = "pat";
    buildWarehousesClient({});
    expect(patTokens).toEqual(["user-pat"]);
    expect(m2mOpts).toEqual([]);
  });

  test("an unsupported DATABRICKS_AUTH_TYPE fails with an actionable message", async () => {
    process.env.DATABRICKS_HOST = "envhost.cloud.databricks.com";
    process.env.DATABRICKS_AUTH_TYPE = "azure-cli";
    buildWarehousesClient({});
    await expect(bearer(ctorOpts[0].credentials)).rejects.toThrow(
      /DATABRICKS_AUTH_TYPE=azure-cli cannot be satisfied/,
    );
    expect(cliCalls).toEqual([]);
  });

  async function send(body?: unknown) {
    buildWarehousesClient({ host: "https://x" });
    const client = ctorOpts[0].httpClient as {
      send(
        r: unknown,
      ): Promise<{ statusCode: number; body: ReadableStream | null }>;
    };
    return client.send({
      url: "https://x/api",
      method: "POST",
      headers: new Headers(),
      ...(body !== undefined && { body }),
    });
  }

  test("transport retries a 429 (legacy behavior) and returns the eventual success", async () => {
    vi.useFakeTimers();
    responses.push({
      statusCode: 429,
      body: '{"error_code":"TOO_MANY_REQUESTS"}',
    });
    const pending = send("{}");
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(responses).toEqual([]);
  });

  test("transport does not retry a plain 400 and keeps its body readable", async () => {
    responses.push({
      statusCode: 400,
      body: '{"message":"Run 1 does not exist."}',
    });
    responses.push({ statusCode: 200, body: "{}" });
    const res = await send("{}");
    expect(res.statusCode).toBe(400);
    expect(await new Response(res.body).text()).toContain(
      "Run 1 does not exist",
    );
    expect(responses).toHaveLength(1);
  });

  test("transport never retries a streamed body (it can only be sent once)", async () => {
    responses.push({ statusCode: 429, body: "{}" });
    const res = await send(new Response("data").body);
    expect(res.statusCode).toBe(429);
  });

  test("modular SDK errors are instanceof the exported ApiError and expose legacy fields", async () => {
    const { ApiError, ModularApiError } = await import("../index");
    const body = new TextEncoder().encode(
      JSON.stringify({
        error_code: "INVALID_PARAMETER_VALUE",
        message: "nope",
      }),
    );
    const err = ModularApiError.fromHttpError(400, undefined, body);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as unknown as { statusCode: number }).statusCode).toBe(400);
    expect((err as unknown as { errorCode: string }).errorCode).toBe(
      "INVALID_PARAMETER_VALUE",
    );
    // Assigning the legacy field (as some connectors do) must not throw.
    Object.assign(err as object, { statusCode: 418 });
    expect((err as unknown as { statusCode: number }).statusCode).toBe(418);
    expect(new Error("x")).not.toBeInstanceOf(ApiError);
    expect(new ApiError("m", "CODE", 404, undefined, [])).toBeInstanceOf(
      ApiError,
    );
  });
});
