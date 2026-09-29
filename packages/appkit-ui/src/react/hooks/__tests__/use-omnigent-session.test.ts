import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let stream: {
  url?: string;
  onMessage?: (msg: { data: string }) => Promise<void>;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
  maxRetries?: number;
} = {};

const mockConnectSSE = vi.fn().mockImplementation((opts: any) => {
  stream = {
    url: opts.url,
    onMessage: opts.onMessage,
    onError: opts.onError,
    signal: opts.signal,
    maxRetries: opts.maxRetries,
  };
  return new Promise<void>(() => {});
});

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import {
  useOmnigentHarnesses,
  useOmnigentSession,
  useOmnigentSessions,
} from "../use-omnigent-session";

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let snapshot: Record<string, unknown> = {};

function mockFetch(
  routes: Record<string, (c: Call) => { status?: number; body: unknown }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const key = Object.keys(routes).find((k) => {
        const [m, p] = k.split(" ");
        return m === call.method && new RegExp(`^${p}$`).test(url);
      });
      const r = key
        ? routes[key](call)
        : { status: 404, body: { error: "no route" } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
}

async function emit(event: object) {
  await act(async () => {
    await stream.onMessage?.({ data: JSON.stringify(event) });
  });
}

describe("useOmnigentSession", () => {
  beforeEach(() => {
    calls = [];
    stream = {};
    snapshot = {
      id: "s1",
      status: "idle",
      mode: "ask",
      items: [],
      pending_elicitations: [],
    };
    mockFetch({
      "GET /api/omnigent/sessions/s1": () => ({ body: snapshot }),
      "POST /api/omnigent/sessions": () => ({
        status: 201,
        body: { session_id: "s1" },
      }),
      "POST /api/omnigent/sessions/s1/messages": () => ({
        status: 202,
        body: { queued: true },
      }),
      "POST /api/omnigent/sessions/s1/interrupt": () => ({ body: {} }),
      "POST /api/omnigent/sessions/s1/elicitations/e1": () => ({
        status: 202,
        body: {},
      }),
      "PUT /api/omnigent/sessions/s1/mode": (c) => ({ body: c.body }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("idle without a session: no fetch, no stream", () => {
    const { result } = renderHook(() => useOmnigentSession());
    expect(result.current.sessionId).toBeNull();
    expect(result.current.items).toEqual([]);
    expect(mockConnectSSE).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("opening a session loads its snapshot and streams it", async () => {
    snapshot.items = [
      {
        type: "message",
        data: { role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
    ];
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(stream.url).toBe("/api/omnigent/sessions/s1/stream");
    expect(stream.maxRetries).toBeGreaterThan(0);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.session?.mode).toBe("ask");
  });

  test("start() creates the session with the given options and opens it", async () => {
    const { result } = renderHook(() => useOmnigentSession());
    let id = "";
    await act(async () => {
      id = await result.current.start({
        harness: "codex",
        mode: "auto",
        message: "hello",
      });
    });
    expect(id).toBe("s1");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/api/omnigent/sessions",
      body: { harness: "codex", mode: "auto", message: "hello" },
    });
    await waitFor(() => expect(result.current.sessionId).toBe("s1"));
    await waitFor(() =>
      expect(stream.url).toBe("/api/omnigent/sessions/s1/stream"),
    );
  });

  test("text deltas build the draft; the end of a turn clears it and refreshes", async () => {
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(stream.onMessage).toBeDefined());
    snapshot.status = "running";
    await emit({ type: "response.output_text.delta", delta: "Hel" });
    await emit({ type: "response.output_text.delta", delta: "lo" });
    expect(result.current.draft).toBe("Hello");
    const before = calls.filter((c) => c.url.endsWith("/s1")).length;
    snapshot.status = "idle";
    snapshot.items = [
      {
        type: "message",
        data: {
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
    ];
    await emit({ type: "response.output_item.done" });
    expect(result.current.draft).toBe("");
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(calls.filter((c) => c.url.endsWith("/s1")).length).toBeGreaterThan(
      before,
    );
    expect(result.current.status).toBe("idle");
  });

  test("heartbeats do not refresh the snapshot", async () => {
    renderHook(() => useOmnigentSession({ sessionId: "s1" }));
    await waitFor(() => expect(stream.onMessage).toBeDefined());
    await waitFor(() => expect(calls.length).toBe(1));
    await emit({ type: "session.heartbeat" });
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.length).toBe(1);
  });

  test("pending approvals surface and approve() resolves with accept", async () => {
    snapshot.pending_elicitations = [
      { elicitation_id: "e1", params: { message: "Changes app data" } },
    ];
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1", onEvent }),
    );
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    await act(async () => {
      await result.current.approve("e1");
    });
    expect(calls.find((c) => c.url.endsWith("/elicitations/e1"))?.body).toEqual(
      { action: "accept" },
    );
    await emit({ type: "session.status", status: "running" });
    expect(onEvent).toHaveBeenCalledWith({
      type: "session.status",
      status: "running",
    });
  });

  test("send, interrupt and setMode call the plugin routes", async () => {
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => {
      await result.current.send("next");
      await result.current.interrupt();
      await result.current.setMode("read");
    });
    const writes = calls
      .filter((c) => c.method !== "GET")
      .map((c) => [
        c.method,
        c.url.replace("/api/omnigent/sessions/s1", ""),
        c.body,
      ]);
    expect(writes).toEqual([
      ["POST", "/messages", { text: "next" }],
      ["POST", "/interrupt", undefined],
      ["PUT", "/mode", { mode: "read" }],
    ]);
  });

  test("route errors surface as error and reject", async () => {
    mockFetch({
      "GET /api/omnigent/sessions/s1": () => ({ body: snapshot }),
      "POST /api/omnigent/sessions/s1/messages": () => ({
        status: 404,
        body: { error: "Session not found" },
      }),
    });
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => {
      await expect(result.current.send("x")).rejects.toThrow(
        "Session not found",
      );
    });
    expect(result.current.error).toBe("Session not found");
  });

  test("actions need a session", async () => {
    const { result } = renderHook(() => useOmnigentSession());
    await expect(result.current.send("x")).rejects.toThrow(/start\(\) first/);
  });

  test("reset() closes the stream and forgets the session", async () => {
    const { result } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(stream.signal).toBeDefined());
    const signal = stream.signal;
    act(() => result.current.reset());
    expect(result.current.sessionId).toBeNull();
    expect(result.current.session).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test("unmount aborts the stream", async () => {
    const { unmount } = renderHook(() =>
      useOmnigentSession({ sessionId: "s1" }),
    );
    await waitFor(() => expect(stream.signal).toBeDefined());
    unmount();
    expect(stream.signal?.aborted).toBe(true);
  });

  test("basePath moves every route", async () => {
    mockFetch({ "GET /x/omni/sessions/s1": () => ({ body: snapshot }) });
    renderHook(() =>
      useOmnigentSession({ sessionId: "s1", basePath: "/x/omni" }),
    );
    await waitFor(() => expect(stream.url).toBe("/x/omni/sessions/s1/stream"));
    await waitFor(() => expect(calls[0].url).toBe("/x/omni/sessions/s1"));
  });
});

describe("useOmnigentHarnesses / useOmnigentSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    calls = [];
  });

  test("loads harness options", async () => {
    mockFetch({
      "GET /api/omnigent/harnesses": () => ({
        body: {
          harnesses: [
            {
              id: "claude-sdk",
              label: "Claude Agent SDK",
              shell: false,
              models: ["m"],
            },
          ],
          modes: ["auto", "ask", "read"],
          defaultMode: "auto",
          defaultHarness: "claude-sdk",
        },
      }),
    });
    const { result } = renderHook(() => useOmnigentHarnesses());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.harnesses.map((h) => h.id)).toEqual(["claude-sdk"]);
    expect(result.current.defaultMode).toBe("auto");
    expect(result.current.defaultHarness).toBe("claude-sdk");
  });

  test("lists and removes sessions", async () => {
    mockFetch({
      "GET /api/omnigent/sessions": () => ({
        body: { data: [{ id: "a" }, { id: "b" }] },
      }),
      "DELETE /api/omnigent/sessions/a": () => ({ body: {} }),
    });
    const { result } = renderHook(() => useOmnigentSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    await act(async () => {
      await result.current.remove("a");
    });
    expect(result.current.sessions.map((s) => s.id)).toEqual(["b"]);
  });
});
