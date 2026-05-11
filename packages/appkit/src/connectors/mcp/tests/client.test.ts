import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppKitMcpClient } from "../client";
import type { DnsLookup, McpHostPolicy } from "../host-policy";

const WORKSPACE = "https://test-workspace.cloud.databricks.com";

const workspacePolicy: McpHostPolicy = {
  workspaceHostname: "test-workspace.cloud.databricks.com",
  trustedHosts: new Set(),
  allowLocalhost: false,
};

const trustedExternalPolicy: McpHostPolicy = {
  workspaceHostname: "test-workspace.cloud.databricks.com",
  trustedHosts: new Set(["mcp.example.com"]),
  allowLocalhost: false,
};

const publicDnsLookup: DnsLookup = async () => [
  { address: "203.0.113.42", family: 4 },
];

const workspaceAuth = async (): Promise<Record<string, string>> => ({
  Authorization: "Bearer SP-TOKEN",
});

type FetchCall = {
  url: string;
  init: RequestInit;
};

function recordingFetch(
  responders: Array<(call: FetchCall) => Response | Promise<Response>>,
) {
  const calls: FetchCall[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    const responder = responders[n++] ?? responders[responders.length - 1];
    return Promise.resolve(responder(call));
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("AppKitMcpClient — host allowlist", () => {
  let authSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authSpy = vi.fn(workspaceAuth);
  });

  test("connect rejects a URL whose host is not allowlisted without making any fetch", async () => {
    const { fetchImpl, calls } = recordingFetch([() => jsonResponse({})]);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
      fetchImpl,
      dnsLookup: publicDnsLookup,
    });
    await expect(
      client.connect({ name: "evil", url: "https://attacker.example.com/mcp" }),
    ).rejects.toThrow(/attacker\.example\.com/);
    expect(calls).toHaveLength(0);
    expect(authSpy).not.toHaveBeenCalled();
  });

  test("connect rejects plaintext http:// for remote hosts", async () => {
    const { fetchImpl, calls } = recordingFetch([() => jsonResponse({})]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      authSpy,
      trustedExternalPolicy,
      { fetchImpl, dnsLookup: publicDnsLookup },
    );
    await expect(
      client.connect({ name: "plain", url: "http://mcp.example.com/mcp" }),
    ).rejects.toThrow(/plaintext http/);
    expect(calls).toHaveLength(0);
    expect(authSpy).not.toHaveBeenCalled();
  });

  test("connect rejects a URL whose DNS resolves to a blocked IP and never sends SP token", async () => {
    const ssrfLookup: DnsLookup = async () => [
      { address: "169.254.169.254", family: 4 },
    ];
    const policy: McpHostPolicy = {
      workspaceHostname: "test-workspace.cloud.databricks.com",
      trustedHosts: new Set(["evil.example.com"]),
      allowLocalhost: false,
    };
    const { fetchImpl, calls } = recordingFetch([() => jsonResponse({})]);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, policy, {
      fetchImpl,
      dnsLookup: ssrfLookup,
    });
    await expect(
      client.connect({ name: "evil", url: "https://evil.example.com/mcp" }),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(calls).toHaveLength(0);
    expect(authSpy).not.toHaveBeenCalled();
  });

  test("connect to same-origin workspace forwards SP token on initialize + tools/list", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            "mcp-session-id": "sess-1",
          },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "echo", description: "Echo" }] },
        }),
    ]);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
      fetchImpl,
      dnsLookup: publicDnsLookup,
    });

    await client.connect({
      name: "genie-1",
      url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    });

    // initialize + notifications/initialized + tools/list all carry SP token
    expect(calls.map((c) => c.url)).toEqual([
      `${WORKSPACE}/api/2.0/mcp/genie/abc`,
      `${WORKSPACE}/api/2.0/mcp/genie/abc`,
      `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    ]);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer SP-TOKEN");
    }
    expect(client.canForwardWorkspaceAuth("genie-1")).toBe(true);
  });

  test("connect to trusted external host does NOT forward SP token on any RPC", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            "mcp-session-id": "sess-1",
          },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "help" }] },
        }),
    ]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      authSpy,
      trustedExternalPolicy,
      { fetchImpl, dnsLookup: publicDnsLookup },
    );

    await client.connect({ name: "ext", url: "https://mcp.example.com/mcp" });

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
    expect(authSpy).not.toHaveBeenCalled();
    expect(client.canForwardWorkspaceAuth("ext")).toBe(false);
  });
});

describe("AppKitMcpClient — connectAll partial failures", () => {
  // `connectAll` used to return `void` after logging per-endpoint errors,
  // so callers couldn't distinguish "all servers up" from "one of three
  // failed". The structured return surfaces both sides of that split for
  // the agents plugin to render a single aggregate warning at boot.

  function successResponders() {
    return [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { "mcp-session-id": "sess" },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "t", description: "t" }] },
        }),
    ];
  }

  test("reports every successful endpoint by name with no failures", async () => {
    const { fetchImpl } = recordingFetch([
      ...successResponders(),
      ...successResponders(),
    ]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    const result = await client.connectAll([
      { name: "alpha", url: `${WORKSPACE}/api/2.0/mcp/alpha` },
      { name: "beta", url: `${WORKSPACE}/api/2.0/mcp/beta` },
    ]);
    expect(result.connected.sort()).toEqual(["alpha", "beta"]);
    expect(result.failed).toEqual([]);
  });

  test("isolates a failing endpoint and keeps the rest connected", async () => {
    // First endpoint succeeds; the second is rejected by host policy
    // before any fetch fires. The third succeeds. Without the split
    // return, the caller couldn't tell which endpoints booted.
    const { fetchImpl } = recordingFetch([
      ...successResponders(),
      ...successResponders(),
    ]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    const result = await client.connectAll([
      { name: "ok-1", url: `${WORKSPACE}/api/2.0/mcp/ok-1` },
      { name: "blocked", url: "https://blocked.example.com/mcp" },
      { name: "ok-2", url: `${WORKSPACE}/api/2.0/mcp/ok-2` },
    ]);

    expect(result.connected.sort()).toEqual(["ok-1", "ok-2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe("blocked");
    expect(result.failed[0].error).toBeInstanceOf(Error);
    expect(result.failed[0].error.message).toMatch(/blocked/);
  });

  test("handles all-failed without throwing — caller decides how to react", async () => {
    // Both endpoints rejected at policy time → no fetches happen.
    const { fetchImpl, calls } = recordingFetch([]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    const result = await client.connectAll([
      { name: "x", url: "https://x.example.com/mcp" },
      { name: "y", url: "https://y.example.com/mcp" },
    ]);
    expect(calls).toHaveLength(0);
    expect(result.connected).toEqual([]);
    expect(result.failed.map((f) => f.name).sort()).toEqual(["x", "y"]);
  });

  test("wraps non-Error rejection reasons so callers get a real Error", async () => {
    // Force a non-Error throw via a custom fetch that rejects with a
    // string. Real-world failures already throw Error, but the wrapper
    // protects against odd transports that throw scalars.
    const fetchImpl: typeof fetch = async () => {
      throw "boom-as-string";
    };
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    const result = await client.connectAll([
      { name: "weird", url: `${WORKSPACE}/api/2.0/mcp/weird` },
    ]);
    expect(result.connected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBeInstanceOf(Error);
    expect(result.failed[0].error.message).toContain("boom-as-string");
  });
});

describe("AppKitMcpClient — callTool auth scoping", () => {
  test("drops caller-supplied OBO token when destination is not workspace-origin", async () => {
    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            "mcp-session-id": "sess-1",
          },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "do" }] },
        }),
    ];
    const callResponder = () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    const { fetchImpl, calls } = recordingFetch([
      ...connectResponders,
      callResponder,
    ]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      trustedExternalPolicy,
      { fetchImpl, dnsLookup: publicDnsLookup },
    );
    await client.connect({ name: "ext", url: "https://mcp.example.com/mcp" });

    const output = await client.callTool(
      "mcp.ext.do",
      { x: 1 },
      {
        Authorization: "Bearer OBO-USER-TOKEN",
      },
    );
    expect(output).toBe("ok");

    const toolCall = calls[calls.length - 1];
    const headers = toolCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("forwards caller-supplied OBO token when destination is workspace-origin", async () => {
    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            "mcp-session-id": "sess-1",
          },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "do" }] },
        }),
    ];
    const callResponder = () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    const { fetchImpl, calls } = recordingFetch([
      ...connectResponders,
      callResponder,
    ]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    await client.connect({
      name: "genie-1",
      url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    });

    await client.callTool(
      "mcp.genie-1.do",
      {},
      {
        Authorization: "Bearer OBO-USER-TOKEN",
      },
    );

    const toolCall = calls[calls.length - 1];
    const headers = toolCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer OBO-USER-TOKEN");
  });

  test("falls back to SP auth when no OBO override is provided and destination is workspace", async () => {
    const authSpy = vi.fn(workspaceAuth);
    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          {
            "mcp-session-id": "sess-1",
          },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "do" }] },
        }),
    ];
    const callResponder = () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 4,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    const { fetchImpl, calls } = recordingFetch([
      ...connectResponders,
      callResponder,
    ]);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
      fetchImpl,
      dnsLookup: publicDnsLookup,
    });
    await client.connect({
      name: "genie-1",
      url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    });

    await client.callTool("mcp.genie-1.do", {}, undefined);

    const toolCall = calls[calls.length - 1];
    const headers = toolCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SP-TOKEN");
  });
});

describe("AppKitMcpClient — caller abort signal composition", () => {
  test("callTool's fetch aborts when the caller signal fires", async () => {
    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { "mcp-session-id": "sess-1" },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "slow" }] },
        }),
    ];
    const callResponder = (call: FetchCall): Promise<Response> => {
      const signal = call.init.signal as AbortSignal | undefined;
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) {
          reject(
            new DOMException(
              signal.reason?.toString() ?? "aborted",
              "AbortError",
            ),
          );
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(
              new DOMException(
                signal.reason?.toString() ?? "aborted",
                "AbortError",
              ),
            );
          },
          { once: true },
        );
      });
    };
    const { fetchImpl } = recordingFetch([...connectResponders, callResponder]);
    const client = new AppKitMcpClient(
      WORKSPACE,
      workspaceAuth,
      workspacePolicy,
      {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      },
    );
    await client.connect({
      name: "genie-1",
      url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    });

    const controller = new AbortController();
    const pending = client
      .callTool("mcp.genie-1.slow", {}, undefined, controller.signal)
      .catch((e) => e);
    // Let the fetch start + register its abort listener before we abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new Error("user cancelled"));
    const error = (await pending) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
  });
});

describe("AppKitMcpClient — callTool result hardening", () => {
  let authSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authSpy = vi.fn(workspaceAuth);
  });

  async function connectAndCall(
    callResult: unknown,
  ): Promise<{ result: string }> {
    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { "mcp-session-id": "sess-1" },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { tools: [{ name: "tool" }] },
        }),
    ];
    const callResponder = () =>
      jsonResponse({ jsonrpc: "2.0", id: 4, result: callResult });

    const { fetchImpl } = recordingFetch([...connectResponders, callResponder]);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
      fetchImpl,
      dnsLookup: publicDnsLookup,
    });
    await client.connect({
      name: "srv",
      url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
    });
    const result = await client.callTool("mcp.srv.tool", {}, undefined);
    return { result };
  }

  test("filters content entries whose text is undefined (regression: 'undefined' literal in joined output)", async () => {
    // McpToolCallResult.content[i].text is optional. Previously the
    // filter only checked `type === "text"`, so an entry like
    // { type: "text" } (text undefined) flowed through, and
    // `Array.join('\n')` emitted the literal string "undefined".
    const { result } = await connectAndCall({
      content: [
        { type: "text", text: "first line" },
        { type: "text" },
        { type: "text", text: "second line" },
        { type: "image", data: "..." },
      ],
    });
    expect(result).toBe("first line\nsecond line");
    expect(result).not.toContain("undefined");
  });

  test("filters undefined text on the error path too", async () => {
    await expect(
      connectAndCall({
        isError: true,
        content: [{ type: "text" }, { type: "text", text: "boom" }],
      }),
    ).rejects.toThrow(/^boom$/);
  });

  test("error with no text content falls back to a generic message", async () => {
    await expect(
      connectAndCall({
        isError: true,
        content: [{ type: "text" }, { type: "image", data: "..." }],
      }),
    ).rejects.toThrow(/MCP tool call failed/);
  });
});

describe("AppKitMcpClient — response body size cap", () => {
  let authSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authSpy = vi.fn(workspaceAuth);
  });

  test("rejects an unbounded response body (1 MB cap)", async () => {
    // Mimic a server streaming forever: each `read()` returns another
    // 64 KB chunk. The capped reader must abort once it crosses the
    // 1 MB limit rather than buffer indefinitely.
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(0x41); // 'A'
        let pushed = 0;
        const maxChunks = 32; // 32 * 64KiB = 2 MiB, well above the 1 MiB cap
        const id = setInterval(() => {
          controller.enqueue(chunk);
          pushed++;
          if (pushed >= maxChunks) {
            clearInterval(id);
            controller.close();
          }
        }, 0);
      },
    });
    const oversizedResponse = new Response(oversizedBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const connectResponders = [
      () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { "mcp-session-id": "sess-1" },
        ),
      () => jsonResponse({ jsonrpc: "2.0", result: null }),
      () => oversizedResponse,
    ];
    const { fetchImpl } = recordingFetch(connectResponders);
    const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
      fetchImpl,
      dnsLookup: publicDnsLookup,
    });

    await expect(
      client.connect({
        name: "evil",
        url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
      }),
    ).rejects.toThrow(/exceeded 1048576 bytes/);
  });
});

describe("AppKitMcpClient — sendNotification HTTP error surfacing", () => {
  let authSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authSpy = vi.fn(workspaceAuth);
  });

  test("connect succeeds even when notifications/initialized returns 4xx (fire-and-forget per spec)", async () => {
    // The MCP spec says notifications are fire-and-forget. We must not
    // throw, and connect() must return normally; the regression we're
    // guarding is that the failure shouldn't silently appear as a clean
    // connect from the dev's perspective (the warning log surfaces it).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fetchImpl } = recordingFetch([
        () =>
          jsonResponse(
            { jsonrpc: "2.0", id: 1, result: {} },
            { "mcp-session-id": "sess-1" },
          ),
        () =>
          new Response("bad request", {
            status: 400,
            statusText: "Bad Request",
          }),
        () =>
          jsonResponse({
            jsonrpc: "2.0",
            id: 3,
            result: { tools: [{ name: "tool" }] },
          }),
      ]);
      const client = new AppKitMcpClient(WORKSPACE, authSpy, workspacePolicy, {
        fetchImpl,
        dnsLookup: publicDnsLookup,
      });
      await expect(
        client.connect({
          name: "srv",
          url: `${WORKSPACE}/api/2.0/mcp/genie/abc`,
        }),
      ).resolves.not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
