import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";

/**
 * `approval.timeoutMs` validation. A misconfigured value (`0`, negative,
 * `NaN`, or `Infinity`) used to silently make every mutating tool call
 * auto-deny before any UI could possibly respond, because the gate's wait
 * resolved immediately. The plugin now clamps anything below the 1s floor
 * back to the 60s default and logs a warning.
 *
 * White-box read of the private getter — `resolvedApprovalPolicy` is the
 * single read-site for `timeoutMs` inside the plugin, and exposing a
 * dedicated public accessor just for tests would leak internals.
 */

function policyOf(plugin: AgentsPlugin) {
  return (plugin as unknown as { resolvedApprovalPolicy: unknown })
    .resolvedApprovalPolicy as {
    requireForDestructive: boolean;
    timeoutMs: number;
  };
}

beforeEach(() => {
  CacheManager.getInstanceSync = vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_k: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(() => "test-key"),
  })) as unknown as typeof CacheManager.getInstanceSync;
});

describe("AgentsPlugin.resolvedApprovalPolicy.timeoutMs", () => {
  test("uses the default (60_000) when approval is omitted", () => {
    const plugin = new AgentsPlugin({});
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("passes valid positive values through unchanged", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: 5_000 } });
    expect(policyOf(plugin).timeoutMs).toBe(5_000);
  });

  test("clamps zero to the default with a warning", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: 0 } });
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("clamps negative values to the default", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: -1 } });
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("clamps NaN to the default", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: Number.NaN } });
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("clamps Infinity to the default (not finite)", () => {
    const plugin = new AgentsPlugin({
      approval: { timeoutMs: Number.POSITIVE_INFINITY },
    });
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("clamps sub-1000ms values to the default (1s floor)", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: 250 } });
    expect(policyOf(plugin).timeoutMs).toBe(60_000);
  });

  test("memoises the validation result — repeated reads return the same object", () => {
    const plugin = new AgentsPlugin({ approval: { timeoutMs: 5_000 } });
    const a = policyOf(plugin);
    const b = policyOf(plugin);
    expect(a).toBe(b);
  });
});
