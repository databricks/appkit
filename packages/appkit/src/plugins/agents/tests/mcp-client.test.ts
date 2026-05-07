import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppKitMcpClient } from "../tools/mcp-client";
import type { DnsLookup, McpHostPolicy } from "../tools/mcp-host-policy";

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
