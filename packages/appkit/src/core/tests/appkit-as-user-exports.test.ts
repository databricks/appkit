import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UserContext } from "../../context/user-context";

/**
 * Tests the exports-level asUser(req) flow:
 *   appkit.plugin.asUser(req).method()
 *
 * Verifies that exported functions are wrapped in runInUserContext(),
 * so getUserContext() returns user context during the call — regardless
 * of whether the export is a class method or an inline arrow function.
 */

// ── Mock heavy dependencies ─────────────────────────────────────────

vi.mock("../../cache", () => ({
  CacheManager: {
    getInstance: vi.fn(async () => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(
        async (_k: unknown[], fn: (signal?: AbortSignal) => Promise<unknown>) =>
          fn(),
      ),
      generateKey: vi.fn(() => "test-key"),
    })),
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(
        async (_k: unknown[], fn: (signal?: AbortSignal) => Promise<unknown>) =>
          fn(),
      ),
      generateKey: vi.fn(() => "test-key"),
    })),
  },
}));

vi.mock("../../telemetry", async () => {
  const actual =
    await vi.importActual<typeof import("../../telemetry")>("../../telemetry");
  return {
    ...actual,
    TelemetryManager: {
      initialize: vi.fn(),
      getProvider: () => ({
        getTracer: () => ({
          startActiveSpan: vi.fn((_name: string, fn: (span: any) => any) =>
            fn({ end: vi.fn(), setStatus: vi.fn(), recordException: vi.fn() }),
          ),
        }),
        getMeter: () => ({
          createCounter: vi.fn(() => ({ add: vi.fn() })),
          createHistogram: vi.fn(() => ({ record: vi.fn() })),
        }),
        getLogger: () => ({ emit: vi.fn() }),
        emit: vi.fn(),
        startActiveSpan: vi.fn(
          async (_n: string, _o: any, fn: (s: any) => any) =>
            fn({ end: vi.fn() }),
        ),
        registerInstrumentations: vi.fn(),
      }),
    },
  };
});

vi.mock("../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../internal-telemetry", () => ({
  isInternalTelemetryEnabled: vi.fn(() => false),
  TelemetryReporter: { report: vi.fn() },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { createMockRequest, setupDatabricksEnv } from "@tools/test-helpers";

import { getUserContext } from "../../context/execution-context";
import { ServiceContext } from "../../context/service-context";
import { Plugin } from "../../plugin/plugin";
import { toPlugin } from "../../plugin/to-plugin";
import { createApp } from "../appkit";

// ── Mock SDK ────────────────────────────────────────────────────────

const { MockWorkspaceClient } = vi.hoisted(() => {
  const MockWorkspaceClient = vi.fn().mockImplementation(() => ({
    currentUser: { me: vi.fn().mockResolvedValue({ id: "sp-user-123" }) },
    apiClient: {
      request: vi.fn().mockResolvedValue({ "x-databricks-org-id": "ws-456" }),
    },
  }));
  return { MockWorkspaceClient };
});

vi.mock("../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../workspace-client")>();
  return {
    ...actual,
    createWorkspaceClient: (...args: unknown[]) => MockWorkspaceClient(...args),
    ConfigError: class extends Error {},
  };
});

// ── Test plugin ─────────────────────────────────────────────────────

/** Captures getUserContext() at call time and returns it. */
class ContextProbePlugin extends Plugin {
  static manifest = {
    name: "probe" as const,
    displayName: "Context Probe",
    description: "Test plugin that captures user context",
    resources: { required: [], optional: [] },
  };

  /** Class method — discoverable by the proxy. */
  getContext() {
    return getUserContext();
  }

  /**
   * Mirrors the analytics `query` export that PR #385 broke: a class method
   * that dereferences `this` (there: `this.queryProcessor`). Exported UNBOUND
   * below. If the asUser proxy hands it out without binding `this`, reading
   * `this.marker` throws "Cannot read properties of undefined" — the exact
   * reported symptom — before it can read the user context.
   */
  private readonly marker = "probe";
  getContextViaThis() {
    if (this.marker !== "probe") throw new Error("wrong instance");
    return getUserContext();
  }

  exports() {
    return {
      // Class method bound to this
      getContext: this.getContext.bind(this),
      // Inline arrow function — the key case this fix addresses
      getContextArrow: () => getUserContext(),
      // Unbound class-method reference (the analytics `query: this.query`
      // pattern). Regression guard for PR #385.
      getContextRaw: this.getContextViaThis,
    };
  }
}

const probe = toPlugin(ContextProbePlugin);

// ── Tests ───────────────────────────────────────────────────────────

describe("exports-level asUser(req)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    ServiceContext.reset();
    setupDatabricksEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    ServiceContext.reset();
  });

  test("class method export runs in user context via asUser(req)", async () => {
    const appkit = (await createApp({ plugins: [probe()] })) as any;

    const req = createMockRequest({
      headers: {
        "x-forwarded-access-token": "user-token-abc",
        "x-forwarded-user": "alice",
        "x-forwarded-email": "alice@example.com",
      },
    });

    const userExports = appkit.probe.asUser(req);
    const ctx = userExports.getContext() as UserContext;

    expect(ctx).toBeDefined();
    expect(ctx.isUserContext).toBe(true);
    expect(ctx.userId).toBe("alice");
  });

  test("inline arrow function export runs in user context via asUser(req)", async () => {
    const appkit = (await createApp({ plugins: [probe()] })) as any;

    const req = createMockRequest({
      headers: {
        "x-forwarded-access-token": "user-token-abc",
        "x-forwarded-user": "bob",
        "x-forwarded-email": "bob@example.com",
      },
    });

    const userExports = appkit.probe.asUser(req);
    const ctx = userExports.getContextArrow() as UserContext;

    expect(ctx).toBeDefined();
    expect(ctx.isUserContext).toBe(true);
    expect(ctx.userId).toBe("bob");
  });

  test("unbound class-method export runs in user context via asUser(req)", async () => {
    // End-to-end guard for PR #385: exercises the full
    // createApp → appkit.plugin.asUser(req).method() path with an export
    // shaped exactly like analytics `query: this.query` (unbound, touches
    // `this`). Pre-fix this threw "Cannot read properties of undefined".
    const appkit = (await createApp({ plugins: [probe()] })) as any;

    const req = createMockRequest({
      headers: {
        "x-forwarded-access-token": "user-token-abc",
        "x-forwarded-user": "carol",
        "x-forwarded-email": "carol@example.com",
      },
    });

    const userExports = appkit.probe.asUser(req);

    expect(() => userExports.getContextRaw()).not.toThrow();
    const ctx = userExports.getContextRaw() as UserContext;
    expect(ctx).toBeDefined();
    expect(ctx.isUserContext).toBe(true);
    expect(ctx.userId).toBe("carol");
  });

  test("SP exports (without asUser) do not have user context", async () => {
    const appkit = (await createApp({ plugins: [probe()] })) as any;

    const ctx = appkit.probe.getContext();
    expect(ctx).toBeUndefined();
  });

  test("dev mode fallback works when no token is present", async () => {
    process.env.NODE_ENV = "development";

    const appkit = (await createApp({ plugins: [probe()] })) as any;

    const req = createMockRequest({
      headers: {}, // No token
    });

    // Should not throw in dev mode
    const userExports = appkit.probe.asUser(req);
    expect(userExports.getContext).toBeDefined();
    expect(typeof userExports.getContext).toBe("function");
  });
});
