import { beforeEach, describe, expect, test, vi } from "vitest";

// The wrapper's own tests are the one place allowed to mock the SDK directly
// (everything else goes through the wrapper). We capture the config the SDK
// `WorkspaceClient` constructor receives so we can assert how wrapper options
// map onto SDK auth config.
const { ctorCalls } = vi.hoisted(() => ({
  ctorCalls: [] as Array<{ config: unknown; options: unknown }>,
}));

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn().mockImplementation((config, options) => {
    ctorCalls.push({ config, options });
    return { config, options };
  }),
  // Re-exported by legacy.ts on module load; stubbed so the import resolves.
  ConfigError: class ConfigError extends Error {},
  Context: class Context {},
  Time: class Time {},
  TimeUnits: { milliseconds: 0 },
  loadConfigFile: vi.fn(),
}));

import { buildLegacyWorkspaceClient } from "../legacy";

describe("buildLegacyWorkspaceClient", () => {
  beforeEach(() => {
    ctorCalls.length = 0;
  });

  test("a valid token uses the PAT path", () => {
    buildLegacyWorkspaceClient({ token: "abc", host: "https://x" });
    expect(ctorCalls[0].config).toEqual({
      host: "https://x",
      token: "abc",
      authType: "pat",
    });
  });

  test("no token falls through to the default auth chain (empty config)", () => {
    buildLegacyWorkspaceClient({});
    expect(ctorCalls[0].config).toEqual({});
  });

  test("host without token passes host only (still default auth)", () => {
    buildLegacyWorkspaceClient({ host: "https://x" });
    expect(ctorCalls[0].config).toEqual({ host: "https://x" });
  });

  // Regression guard (PR #475 review): an explicit empty-string token must
  // stick to the PAT path so the SDK rejects it loudly, NOT fall through to
  // default auth and silently run as the service principal — that would be a
  // privilege escalation in the OBO path.
  test("an empty-string token stays on the PAT path, not SP fallback", () => {
    buildLegacyWorkspaceClient({ token: "", host: "https://x" });
    expect(ctorCalls[0].config).toEqual({
      host: "https://x",
      token: "",
      authType: "pat",
    });
    // Must NOT have degraded to the host-only / default-auth branch.
    expect(ctorCalls[0].config).not.toEqual({ host: "https://x" });
  });

  test("authType defaults to pat and is overridable", () => {
    buildLegacyWorkspaceClient({ token: "abc", host: "https://x" });
    expect((ctorCalls[0].config as { authType: string }).authType).toBe("pat");
  });
});
