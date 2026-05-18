import type express from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";

/**
 * Focused tests for the `POST /approve` route and the associated
 * ownership / error paths on `_handleApprove`. Covers:
 *
 *   - Schema validation of the request body.
 *   - Ownership check: the user submitting the decision must be the same
 *     user who initiated the underlying chat stream.
 *   - 404 for unknown stream (already completed or never existed).
 *   - 404 for unknown approvalId even when the stream is active.
 *   - Happy-path resolution of a pending gate with `approve` and `deny`.
 *   - Cancel of an active stream denies every pending gate on that stream.
 */

function mockReq(body: unknown, userId?: string): express.Request {
  const headers: Record<string, string> = {};
  if (userId) {
    headers["x-forwarded-user"] = userId;
    headers["x-forwarded-access-token"] = "fake-token";
  }
  return {
    body,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
}

function mockRes() {
  const json = vi.fn();
  const end = vi.fn();
  let statusCode = 200;
  const status = vi.fn((code: number) => {
    statusCode = code;
    return { json, end };
  });
  return {
    res: { status, json, end } as unknown as express.Response,
    get statusCode() {
      return statusCode;
    },
    json,
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
  })) as any;
  process.env.NODE_ENV = "development";
});

describe("POST /approve route handler", () => {
  test("rejects invalid body shape with 400", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { res, json } = mockRes();
    await (plugin as any)._handleApprove(mockReq({}, "alice"), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Invalid request" }),
    );
  });

  test("returns 404 when the streamId is unknown", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleApprove: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleApprove(
      mockReq(
        { streamId: "ghost", approvalId: "a1", decision: "approve" },
        "alice",
      ),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/not found/i) }),
    );
  });

  test("returns 403 when submitter is different from stream owner", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    (plugin as any).activeStreams.set("stream-x", {
      controller: new AbortController(),
      userId: "alice",
    });
    const gate = (plugin as any).approvalGate;
    const waiter = gate.wait({
      approvalId: "a1",
      streamId: "stream-x",
      userId: "alice",
      timeoutMs: 60_000,
    });

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleApprove: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleApprove(
      mockReq(
        { streamId: "stream-x", approvalId: "a1", decision: "approve" },
        "bob",
      ),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Forbidden" }),
    );

    // Settle the waiter to clean up.
    gate.submit({ approvalId: "a1", userId: "alice", decision: "deny" });
    await expect(waiter).resolves.toBe("deny");
  });

  test("returns 404 when approvalId is unknown on an active stream", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    (plugin as any).activeStreams.set("stream-y", {
      controller: new AbortController(),
      userId: "alice",
    });
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleApprove: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleApprove(
      mockReq(
        { streamId: "stream-y", approvalId: "unknown-a", decision: "approve" },
        "alice",
      ),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/not found|already settled/i),
      }),
    );
  });

  test("happy path: approve resolves pending gate with 'approve'", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    (plugin as any).activeStreams.set("stream-z", {
      controller: new AbortController(),
      userId: "alice",
    });
    const gate = (plugin as any).approvalGate;
    const waiter = gate.wait({
      approvalId: "a42",
      streamId: "stream-z",
      userId: "alice",
      timeoutMs: 60_000,
    });

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleApprove: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleApprove(
      mockReq(
        { streamId: "stream-z", approvalId: "a42", decision: "approve" },
        "alice",
      ),
      res,
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ decision: "approve" });
    await expect(waiter).resolves.toBe("approve");
  });

  test("happy path: deny resolves pending gate with 'deny'", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    (plugin as any).activeStreams.set("stream-z", {
      controller: new AbortController(),
      userId: "alice",
    });
    const gate = (plugin as any).approvalGate;
    const waiter = gate.wait({
      approvalId: "a43",
      streamId: "stream-z",
      userId: "alice",
      timeoutMs: 60_000,
    });

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleApprove: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleApprove(
      mockReq(
        { streamId: "stream-z", approvalId: "a43", decision: "deny" },
        "alice",
      ),
      res,
    );
    expect(json).toHaveBeenCalledWith({ decision: "deny" });
    await expect(waiter).resolves.toBe("deny");
  });
});

describe("POST /cancel ownership + gate cleanup", () => {
  test("cancelling a stream denies every pending approval on that stream", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const controller = new AbortController();
    (plugin as any).activeStreams.set("stream-c", {
      controller,
      userId: "alice",
    });
    const gate = (plugin as any).approvalGate;
    const a = gate.wait({
      approvalId: "ca1",
      streamId: "stream-c",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const b = gate.wait({
      approvalId: "ca2",
      streamId: "stream-c",
      userId: "alice",
      timeoutMs: 60_000,
    });

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleCancel: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleCancel(mockReq({ streamId: "stream-c" }, "alice"), res);

    expect(controller.signal.aborted).toBe(true);
    expect(json).toHaveBeenCalledWith({ cancelled: true });
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
  });

  test("cancel from a different user is refused with 403", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const controller = new AbortController();
    (plugin as any).activeStreams.set("stream-d", {
      controller,
      userId: "alice",
    });
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleCancel: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleCancel(mockReq({ streamId: "stream-d" }, "bob"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(controller.signal.aborted).toBe(false);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Forbidden" }),
    );
  });
});
