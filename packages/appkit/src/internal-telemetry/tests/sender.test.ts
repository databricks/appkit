import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppkitLog } from "../appkit-log";
import { sendAppkitLogs } from "../sender";

function createMockClient(): WorkspaceClient {
  return {
    config: {
      authenticate: vi.fn(async (headers: Headers) => {
        headers.set("Authorization", "Bearer mock-sp-token");
      }),
    },
  } as unknown as WorkspaceClient;
}

const defaultOpts = () => ({
  workspaceHost: "https://my-workspace.cloud.databricks.com",
  workspaceId: "1234567890",
  client: createMockClient(),
});

const sampleLog: AppkitLog = {
  event_name: "APP_STARTUP",
  app_id: "app-id",
  appkit_version: "0.27.0",
  app_startup_event: { placeholder: true },
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendAppkitLogs", () => {
  test("returns null when there are no logs", async () => {
    const result = await sendAppkitLogs([], defaultOpts());
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("POSTs to the SP-friendly /telemetry-ext endpoint", async () => {
    await sendAppkitLogs([sampleLog], defaultOpts());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("manual");
  });

  test("authenticates via WorkspaceClient and sets headers", async () => {
    const opts = defaultOpts();
    await sendAppkitLogs([sampleLog], opts);

    expect(opts.client.config.authenticate).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Databricks-Org-Id")).toBe("1234567890");
    expect(headers.get("Authorization")).toBe("Bearer mock-sp-token");
  });

  test("encodes one protoLog entry per AppkitLog", async () => {
    await sendAppkitLogs([sampleLog, sampleLog, sampleLog], defaultOpts());

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.protoLogs).toHaveLength(3);
    expect(body.items).toEqual([]);
    expect(typeof body.uploadTime).toBe("number");
    const proto = JSON.parse(body.protoLogs[0]);
    expect(proto.entry.appkit_log).toMatchObject({
      event_name: "APP_STARTUP",
      app_id: "app-id",
    });
  });

  test("follows one redirect preserving auth headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", {
        status: 307,
        headers: { location: "https://redirected.example.com/telemetry-ext" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    await sendAppkitLogs([sampleLog], defaultOpts());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [redirectUrl, redirectOptions] = fetchSpy.mock.calls[1];
    expect(String(redirectUrl)).toBe(
      "https://redirected.example.com/telemetry-ext",
    );
    const redirectHeaders = redirectOptions.headers as Headers;
    expect(redirectHeaders.get("Authorization")).toBe("Bearer mock-sp-token");
    expect(redirectOptions.method).toBe("POST");
  });

  test("resolves relative redirect URLs against the original host", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", {
        status: 302,
        headers: { location: "/login.html?next_url=%2Ftelemetry-ext" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    await sendAppkitLogs([sampleLog], defaultOpts());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [redirectUrl] = fetchSpy.mock.calls[1];
    expect(String(redirectUrl)).toBe(
      "https://my-workspace.cloud.databricks.com/login.html?next_url=%2Ftelemetry-ext",
    );
  });

  test("propagates fetch errors to the caller", async () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));

    await expect(sendAppkitLogs([sampleLog], defaultOpts())).rejects.toThrow(
      "network failure",
    );
  });

  test("returns 4xx/5xx responses without throwing", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await sendAppkitLogs([sampleLog], defaultOpts());
    expect(result?.response.status).toBe(500);
    expect(result?.response.body).toBe("boom");
  });

  test("propagates authentication failures", async () => {
    const opts = defaultOpts();
    (
      opts.client.config.authenticate as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("auth failed"));

    await expect(sendAppkitLogs([sampleLog], opts)).rejects.toThrow(
      "auth failed",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceHost is empty", async () => {
    await expect(
      sendAppkitLogs([sampleLog], { ...defaultOpts(), workspaceHost: "" }),
    ).rejects.toThrow(/workspaceHost/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceId is empty", async () => {
    await expect(
      sendAppkitLogs([sampleLog], { ...defaultOpts(), workspaceId: "" }),
    ).rejects.toThrow(/workspaceId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns the dispatched request and response", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await sendAppkitLogs([sampleLog], defaultOpts());
    expect(result?.request.method).toBe("POST");
    expect(result?.request.url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
    expect(result?.response.status).toBe(200);
    expect(result?.response.body).toBe("ok");
  });

  test("normalizes a host without protocol", async () => {
    await sendAppkitLogs([sampleLog], {
      ...defaultOpts(),
      workspaceHost: "my-workspace.cloud.databricks.com",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });

  test("strips trailing slashes from the host", async () => {
    await sendAppkitLogs([sampleLog], {
      ...defaultOpts(),
      workspaceHost: "https://my-workspace.cloud.databricks.com///",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });
});
