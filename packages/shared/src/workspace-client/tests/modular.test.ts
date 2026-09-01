import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly.
// Capture the `ClientOptions` the modular `WarehousesClient` constructor receives
// so we can assert how wrapper options map onto the modular SDK's config.
const { ctorOpts, patTokens, productCalls } = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  patTokens: [] as string[],
  productCalls: [] as Array<[string, string]>,
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
}));
vi.mock("@databricks/sdk-core/clientinfo", () => ({
  setProduct: vi.fn((name: string, version: string) => {
    // Mirror the real SDK: reject client-info keys that aren't simple tokens.
    if (/[^A-Za-z0-9._-]/.test(name)) {
      throw new Error(`Invalid key: ${name}.`);
    }
    productCalls.push([name, version]);
  }),
  addToDefault: vi.fn(),
}));

import { buildWarehousesClient } from "../modular";

describe("modular mapToClientOptions (via buildWarehousesClient)", () => {
  const originalHost = process.env.DATABRICKS_HOST;

  beforeEach(() => {
    ctorOpts.length = 0;
    patTokens.length = 0;
    productCalls.length = 0;
    delete process.env.DATABRICKS_HOST;
  });

  afterEach(() => {
    if (originalHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = originalHost;
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

  test("client-info: sanitizes an invalid product name (e.g. @databricks/appkit) rather than crashing the client build", () => {
    // Regression: the modular SDK's `setProduct` rejects `@databricks/appkit`
    // (INVALID_KEY), which the legacy SDK accepted. UA stamping must be
    // best-effort — a bad product string must never break client construction.
    const client = buildWarehousesClient({
      clientOptions: {
        product: "@databricks/appkit",
        productVersion: "0.64.0",
        userAgentExtra: { mode: "dev" },
      },
    } as never);
    expect(client).toBeDefined();
    expect(productCalls[0]).toEqual(["databricks-appkit", "0.64.0"]);
  });
});
