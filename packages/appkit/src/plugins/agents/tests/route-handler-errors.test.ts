import type express from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";

/**
 * Surface-level guarantees on the agents plugin's HTTP route handlers when
 * downstream dependencies fail. Prior to PR #305 review finding #1+#2,
 * `_handleChat` and `_handleInvocations` awaited `threadStore` without a
 * try/catch — a backing-store failure (DB unreachable, permission error)
 * would propagate the rejection without writing a response and the SSE
 * client would hang until the upstream proxy timeout.
 */

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test seam, mirrors other suites
  (CacheManager as any).instance = {
    get: vi.fn(),
    set: vi.fn(),
    getOrExecute: vi.fn(async (_k: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(() => "test-key"),
  };
});

function mockReq(body: unknown, userId = "alice"): express.Request {
  const headers: Record<string, string> = {
    "x-forwarded-user": userId,
    "x-forwarded-access-token": "fake-token",
  };
  return {
    body,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
}

function mockRes() {
  const json = vi.fn();
  const setHeader = vi.fn();
  let statusCode = 200;
  const status = vi.fn((code: number) => {
    statusCode = code;
    return { json };
  });
  return {
    res: { status, json, setHeader } as unknown as express.Response,
    get statusCode() {
      return statusCode;
    },
    json,
  };
}

function seedPlugin(): AgentsPlugin {
  const plugin = new AgentsPlugin({ dir: false });
  // biome-ignore lint/suspicious/noExplicitAny: seed private state
  (plugin as any).agents.set("default", {
    name: "default",
    instructions: "hi",
    adapter: { async *run() {} },
    toolIndex: new Map(),
  });
  // biome-ignore lint/suspicious/noExplicitAny: seed private state
  (plugin as any).defaultAgentName = "default";
  return plugin;
}

describe("POST /chat — threadStore failure", () => {
  test("returns 500 when threadStore.get rejects (existing thread path)", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub threadStore for failure
    (plugin as any).threadStore = {
      get: vi.fn().mockRejectedValue(new Error("DB unreachable")),
      create: vi.fn(),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi", threadId: "t-1" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.create rejects (new-thread path)", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    (plugin as any).threadStore = {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(new Error("Disk full")),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.addMessage rejects", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    (plugin as any).threadStore = {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi.fn().mockRejectedValue(new Error("Quota exceeded")),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });
});

describe("POST /invocations — threadStore failure", () => {
  test("returns 500 when threadStore.create rejects", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    (plugin as any).threadStore = {
      create: vi.fn().mockRejectedValue(new Error("DB unreachable")),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvocations: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvocations(mockReq({ input: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.addMessage rejects mid-loop", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Conflict")),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvocations: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvocations(
      mockReq({
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });
});
