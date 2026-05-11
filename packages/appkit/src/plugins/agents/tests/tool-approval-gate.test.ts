import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolApprovalGate } from "../tool-approval-gate";

describe("ToolApprovalGate", () => {
  let gate: ToolApprovalGate;

  beforeEach(() => {
    vi.useFakeTimers();
    gate = new ToolApprovalGate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves with 'approve' when a matching submit arrives", async () => {
    const waiter = gate.wait({
      approvalId: "a1",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    expect(gate.size).toBe(1);

    const result = gate.submit({
      approvalId: "a1",
      userId: "alice",
      decision: "approve",
    });

    expect(result).toEqual({ ok: true });
    await expect(waiter).resolves.toBe("approve");
    expect(gate.size).toBe(0);
  });

  test("resolves with 'deny' on explicit deny", async () => {
    const waiter = gate.wait({
      approvalId: "a2",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    gate.submit({
      approvalId: "a2",
      userId: "alice",
      decision: "deny",
    });
    await expect(waiter).resolves.toBe("deny");
  });

  test("auto-denies after timeoutMs with no submit", async () => {
    const waiter = gate.wait({
      approvalId: "a3",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    await expect(waiter).resolves.toBe("deny");
    expect(gate.size).toBe(0);
  });

  test("refuses a submit from a different user (ownership check)", async () => {
    const waiter = gate.wait({
      approvalId: "a4",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const result = gate.submit({
      approvalId: "a4",
      userId: "bob",
      decision: "approve",
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(gate.size).toBe(1);
    // Waiter is still pending; cleanup to let fake timers drain.
    gate.submit({
      approvalId: "a4",
      userId: "alice",
      decision: "deny",
    });
    await expect(waiter).resolves.toBe("deny");
  });

  test("returns 'unknown' reason when approvalId is not registered", () => {
    expect(
      gate.submit({ approvalId: "nope", userId: "x", decision: "approve" }),
    ).toEqual({ ok: false, reason: "unknown" });
  });

  test("abortStream denies every pending gate for that stream", async () => {
    const a = gate.wait({
      approvalId: "a5",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const b = gate.wait({
      approvalId: "a6",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const c = gate.wait({
      approvalId: "a7",
      streamId: "s2",
      userId: "alice",
      timeoutMs: 60_000,
    });
    gate.abortStream("s1");
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(gate.size).toBe(1);
    // s2's waiter is still pending; settle it to clean up timers.
    gate.submit({ approvalId: "a7", userId: "alice", decision: "deny" });
    await expect(c).resolves.toBe("deny");
  });

  test("abortAll denies every pending gate", async () => {
    const a = gate.wait({
      approvalId: "a8",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const b = gate.wait({
      approvalId: "a9",
      streamId: "s2",
      userId: "bob",
      timeoutMs: 60_000,
    });
    gate.abortAll();
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(gate.size).toBe(0);
  });

  test("a timed-out approval cannot be resolved by a late submit", async () => {
    const waiter = gate.wait({
      approvalId: "a10",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 500,
    });
    vi.advanceTimersByTime(500);
    await expect(waiter).resolves.toBe("deny");

    const late = gate.submit({
      approvalId: "a10",
      userId: "alice",
      decision: "approve",
    });
    expect(late).toEqual({ ok: false, reason: "unknown" });
  });
});
