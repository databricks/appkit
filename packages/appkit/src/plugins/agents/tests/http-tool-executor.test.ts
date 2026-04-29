import type express from "express";
import type { ResponseStreamEvent } from "shared";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedToolEntry } from "../../../core/agent/types";
import { EventChannel } from "../event-channel";
import { AgentEventTranslator } from "../event-translator";
import { HttpToolExecutor, type ToolBudget } from "../http-tool-executor";
import { ToolApprovalGate } from "../tool-approval-gate";

/**
 * Focused tests for HttpToolExecutor — particularly the sub-agent approval
 * forwarding path. The runner-level abstraction makes it tractable to drive
 * the executor without spinning up a full HTTP stream:
 *
 *   - Per-run budget gating (top-level enforces, sub-agents skip)
 *   - approval_pending emission to the parent's outbound channel
 *   - approve / deny decision flow
 *   - Sub-agent dispatch reuses the parent's checkApproval (the bit that
 *     used to be a private nested closure inside `_streamAgent` and was
 *     hard to test pre-refactor)
 */

function functionEntry(
  name: string,
  opts?: { effect?: "write" | "destructive" },
) {
  const ann = opts?.effect ? { effect: opts.effect } : undefined;
  return {
    source: "function",
    def: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      annotations: ann,
    },
    functionTool: {
      name,
      description: `${name} tool`,
      schema: { type: "object", properties: {} },
      annotations: ann,
      execute: vi.fn(async () => `${name}-result`),
    },
  } as unknown as ResolvedToolEntry;
}

function subAgentEntry(name: string) {
  return {
    source: "subagent",
    agentName: name,
    def: {
      name: `agent-${name}`,
      description: `Delegate to ${name}`,
      parameters: { type: "object", properties: {} },
    },
  } as unknown as ResolvedToolEntry;
}

function mockReq(): express.Request {
  return {
    headers: { "x-forwarded-user": "alice" },
    header: () => "alice",
  } as unknown as express.Request;
}

function fixture(opts?: {
  budget?: ToolBudget | null;
  requireForDestructive?: boolean;
  toolIndex?: Map<string, ResolvedToolEntry>;
  runSubAgent?: HttpToolExecutorDepsRunSubAgent;
}) {
  const outboundEvents = new EventChannel<ResponseStreamEvent>();
  const translator = new AgentEventTranslator();
  const approvalGate = new ToolApprovalGate();
  const abortController = new AbortController();
  const toolIndex =
    opts?.toolIndex ??
    new Map<string, ResolvedToolEntry>([
      ["safe", functionEntry("safe")],
      ["risky", functionEntry("risky", { effect: "write" })],
    ]);

  const executor = new HttpToolExecutor({
    toolIndex,
    approvalPolicy: {
      requireForDestructive: opts?.requireForDestructive ?? true,
      timeoutMs: 5_000,
    },
    approvalGate,
    translator,
    outboundEvents,
    abortController,
    budget: opts?.budget === undefined ? { used: 0, limit: 50 } : opts.budget,
    req: mockReq(),
    streamId: "stream-1",
    userId: "alice",
    pluginContext: undefined,
    mcpClient: null,
    runSubAgent:
      opts?.runSubAgent ??
      ((_n, _a, _s, _f, _c) => Promise.resolve("(no sub-agent)")),
  });

  return {
    executor,
    outboundEvents,
    approvalGate,
    abortController,
    toolIndex,
    drainEvents: async () => {
      const events: ResponseStreamEvent[] = [];
      // Cap reads so a hang here surfaces as a test timeout, not a leak.
      for (let i = 0; i < 100; i++) {
        const next = await Promise.race([
          (async () => {
            for await (const ev of outboundEvents) return ev;
            return null;
          })(),
          new Promise<null>((r) => setTimeout(() => r(null), 10)),
        ]);
        if (!next) break;
        events.push(next);
      }
      return events;
    },
  };
}

type HttpToolExecutorDepsRunSubAgent = ConstructorParameters<
  typeof HttpToolExecutor
>[0]["runSubAgent"];

describe("HttpToolExecutor", () => {
  describe("budget", () => {
    test("rejects + aborts when top-level budget is exhausted", async () => {
      const { executor, abortController } = fixture({
        budget: { used: 50, limit: 50 },
      });

      await expect(
        executor.execute("safe", {}, abortController.signal),
      ).rejects.toThrow(/Tool-call budget exhausted/);

      expect(abortController.signal.aborted).toBe(true);
    });

    test("budget=null skips counting (sub-agent semantics)", async () => {
      const { executor, abortController } = fixture({ budget: null });

      const r1 = await executor.execute("safe", {}, abortController.signal);
      const r2 = await executor.execute("safe", {}, abortController.signal);
      expect(r1).toBe("safe-result");
      expect(r2).toBe("safe-result");
      expect(abortController.signal.aborted).toBe(false);
    });
  });

  describe("approval gate", () => {
    test("non-destructive tools bypass the gate", async () => {
      const { executor, abortController, outboundEvents } = fixture();

      const result = await executor.execute("safe", {}, abortController.signal);

      expect(result).toBe("safe-result");
      // Drain — there should be no approval_pending event in the channel.
      outboundEvents.close();
      const events: ResponseStreamEvent[] = [];
      for await (const ev of outboundEvents) events.push(ev);
      const approvals = events.filter(
        (e) => e.type === "appkit.approval_pending",
      );
      expect(approvals).toEqual([]);
    });

    test("write-effect tool emits approval_pending and waits for decision", async () => {
      const { executor, abortController, approvalGate, outboundEvents } =
        fixture();

      const promise = executor.execute("risky", {}, abortController.signal);

      // The executor pushes approval_pending synchronously and then awaits
      // the gate. Settle the gate by reading the approvalId from the SSE
      // payload — this mirrors what `POST /approve` does in production.
      const approvalId = await readApprovalId(outboundEvents);
      expect(approvalId).toBeDefined();

      approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "approve",
      });

      const result = await promise;
      expect(result).toBe("risky-result");
    });

    test("denied destructive tool returns a deny string instead of dispatching", async () => {
      const { executor, abortController, approvalGate, outboundEvents } =
        fixture();

      const promise = executor.execute("risky", {}, abortController.signal);

      const approvalId = await readApprovalId(outboundEvents);

      approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "deny",
      });

      const result = await promise;
      expect(result).toMatch(/denied by user approval gate/);
    });

    test("requireForDestructive=false short-circuits the gate even on write tools", async () => {
      const { executor, abortController, outboundEvents } = fixture({
        requireForDestructive: false,
      });

      const result = await executor.execute(
        "risky",
        {},
        abortController.signal,
      );
      expect(result).toBe("risky-result");

      outboundEvents.close();
      const seen: ResponseStreamEvent[] = [];
      for await (const ev of outboundEvents) seen.push(ev);
      expect(seen.some((e) => e.type === "appkit.approval_pending")).toBe(
        false,
      );
    });
  });

  describe("sub-agent approval forwarding", () => {
    test("destructive tool inside a sub-agent surfaces approval_pending on the parent's stream", async () => {
      // This is the bit that used to be a private nested closure inside
      // `_streamAgent` and was effectively untestable pre-refactor: the
      // parent's `checkApproval` is passed *into* the sub-agent's runner
      // so the SSE payload lands on the parent's outbound channel.
      const childIndex = new Map<string, ResolvedToolEntry>([
        ["destroy", functionEntry("destroy", { effect: "destructive" })],
      ]);

      const parentIndex = new Map<string, ResolvedToolEntry>([
        ["agent-worker", subAgentEntry("worker")],
      ]);

      // Spy on what the runSubAgent factory receives.
      const runSubAgentSpy = vi.fn<HttpToolExecutorDepsRunSubAgent>(
        async (_name, _args, signal, _forwardEvent, checkApproval) => {
          // Sub-agent invokes its destructive tool through the parent's
          // approval check, exactly as `runSubAgent.childExecute` does.
          const childEntry = childIndex.get("destroy");
          if (!childEntry) throw new Error("destroy missing from child index");
          const decision = await checkApproval(childEntry, { x: 1 });
          if (decision === "deny") return "denied";
          if (signal.aborted) throw new Error("aborted");
          return "destroyed";
        },
      );

      const { executor, approvalGate, outboundEvents, abortController } =
        fixture({
          toolIndex: parentIndex,
          runSubAgent: runSubAgentSpy,
        });

      const promise = executor.execute(
        "agent-worker",
        { input: "do it" },
        abortController.signal,
      );

      const { approvalId, toolName } =
        await readApprovalDetails(outboundEvents);

      expect(toolName, "approval_pending must surface on parent stream").toBe(
        "destroy",
      );

      approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "approve",
      });

      await expect(promise).resolves.toBe("destroyed");
      expect(runSubAgentSpy).toHaveBeenCalledTimes(1);
    });

    test("denied sub-agent tool yields a deny string handled inside the sub-agent", async () => {
      const childIndex = new Map<string, ResolvedToolEntry>([
        ["destroy", functionEntry("destroy", { effect: "destructive" })],
      ]);
      const parentIndex = new Map<string, ResolvedToolEntry>([
        ["agent-worker", subAgentEntry("worker")],
      ]);

      const runSubAgentSpy = vi.fn<HttpToolExecutorDepsRunSubAgent>(
        async (_name, _args, _signal, _forward, checkApproval) => {
          const childEntry = childIndex.get("destroy");
          if (!childEntry) throw new Error("destroy missing from child index");
          const decision = await checkApproval(childEntry, {});
          if (decision === "deny") return "child-saw-deny";
          return "should-not-happen";
        },
      );

      const { executor, approvalGate, outboundEvents, abortController } =
        fixture({
          toolIndex: parentIndex,
          runSubAgent: runSubAgentSpy,
        });

      const promise = executor.execute(
        "agent-worker",
        { input: "x" },
        abortController.signal,
      );

      const approvalId = await readApprovalId(outboundEvents);

      approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "deny",
      });

      await expect(promise).resolves.toBe("child-saw-deny");
    });
  });
});

interface ApprovalEvent {
  type: "appkit.approval_pending";
  approval_id: string;
  tool_name: string;
}

async function readApprovalDetails(
  channel: EventChannel<ResponseStreamEvent>,
): Promise<{ approvalId: string; toolName: string }> {
  for await (const ev of channel) {
    if (ev.type === "appkit.approval_pending") {
      const a = ev as unknown as ApprovalEvent;
      return { approvalId: a.approval_id, toolName: a.tool_name };
    }
  }
  throw new Error("Channel closed before approval_pending arrived");
}

async function readApprovalId(
  channel: EventChannel<ResponseStreamEvent>,
): Promise<string> {
  return (await readApprovalDetails(channel)).approvalId;
}
