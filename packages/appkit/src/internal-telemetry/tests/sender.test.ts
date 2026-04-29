import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sendStartupTelemetry } from "../sender";

function createMockClient(): WorkspaceClient {
  return {
    config: {
      authenticate: vi.fn(async (headers: Headers) => {
        headers.set("Authorization", "Bearer mock-sp-token");
      }),
    },
  } as unknown as WorkspaceClient;
}

const defaultParams = () => ({
  workspaceHost: "https://my-workspace.cloud.databricks.com",
  workspaceId: "1234567890",
  client: createMockClient(),
  appkitVersion: "0.22.0",
  appName: "test-app",
  plugins: ["server", "analytics"],
  environment: "production",
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendStartupTelemetry", () => {
  test("sends POST to authenticated endpoint URL", async () => {
    await sendStartupTelemetry(defaultParams());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });

  test("authenticates using the WorkspaceClient", async () => {
    const params = defaultParams();
    await sendStartupTelemetry(params);

    expect(params.client.config.authenticate).toHaveBeenCalledOnce();
  });

  test("sends correct headers including auth", async () => {
    await sendStartupTelemetry(defaultParams());

    const [, options] = fetchSpy.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Databricks-Org-Id")).toBe("1234567890");
    expect(headers.get("Authorization")).toBe("Bearer mock-sp-token");
  });

  test("sends correct payload structure", async () => {
    await sendStartupTelemetry(defaultParams());

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body).toHaveProperty("uploadTime");
    expect(typeof body.uploadTime).toBe("number");
    expect(body.items).toEqual([]);
    expect(body.protoLogs).toHaveLength(1);
    expect(typeof body.protoLogs[0]).toBe("string");
  });

  test("sends correct observability log format", async () => {
    await sendStartupTelemetry(defaultParams());

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    const protoLog = JSON.parse(body.protoLogs[0]);

    expect(protoLog.frontend_log_event_id).toMatch(/^appkit-startup-/);
    expect(typeof protoLog.inferred_timestamp_millis).toBe("number");
    expect(protoLog.entry.observability_log).toEqual({
      type: "INTERACTION_PHASE",
      entity: {
        type: "INTERACTION",
        sub_type: "INITIAL_LOAD",
        entity_id: "appkit:0.22.0:production:server,analytics",
      },
      client_source: "APPKIT",
    });
  });

  test("packs metadata into entity_id", async () => {
    await sendStartupTelemetry({
      ...defaultParams(),
      appkitVersion: "1.0.0",
      environment: "development",
      plugins: ["server", "genie", "files"],
    });

    const [, options] = fetchSpy.mock.calls[0];
    const protoLog = JSON.parse(JSON.parse(options.body).protoLogs[0]);

    expect(protoLog.entry.observability_log.entity.entity_id).toBe(
      "appkit:1.0.0:development:server,genie,files",
    );
  });

  test("uses POST method with manual redirect", async () => {
    await sendStartupTelemetry(defaultParams());

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("manual");
  });

  test("follows one redirect preserving auth headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", {
        status: 307,
        headers: { location: "https://redirected.example.com/telemetry" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    await sendStartupTelemetry(defaultParams());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [redirectUrl, redirectOptions] = fetchSpy.mock.calls[1];
    expect(String(redirectUrl)).toBe(
      "https://redirected.example.com/telemetry",
    );
    const redirectHeaders = redirectOptions.headers as Headers;
    expect(redirectHeaders.get("Authorization")).toBe("Bearer mock-sp-token");
    expect(redirectHeaders.get("X-Databricks-Org-Id")).toBe("1234567890");
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

    await sendStartupTelemetry(defaultParams());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [redirectUrl] = fetchSpy.mock.calls[1];
    expect(String(redirectUrl)).toBe(
      "https://my-workspace.cloud.databricks.com/login.html?next_url=%2Ftelemetry-ext",
    );
  });

  test("propagates fetch errors to the caller", async () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));

    await expect(sendStartupTelemetry(defaultParams())).rejects.toThrow(
      "network failure",
    );
  });

  test("returns 4xx/5xx responses without throwing", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await sendStartupTelemetry(defaultParams());
    expect(result.response.status).toBe(500);
    expect(result.response.body).toBe("boom");
  });

  test("propagates authentication failures", async () => {
    const params = defaultParams();
    (
      params.client.config.authenticate as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("auth failed"));

    await expect(sendStartupTelemetry(params)).rejects.toThrow("auth failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceHost is empty", async () => {
    await expect(
      sendStartupTelemetry({ ...defaultParams(), workspaceHost: "" }),
    ).rejects.toThrow(/workspaceHost/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceId is empty", async () => {
    await expect(
      sendStartupTelemetry({ ...defaultParams(), workspaceId: "" }),
    ).rejects.toThrow(/workspaceId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns the dispatched request and response", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await sendStartupTelemetry(defaultParams());
    expect(result.request.method).toBe("POST");
    expect(result.request.url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
    expect(result.request.headers["content-type"]).toBe("application/json");
    expect(result.request.headers.authorization).toBe("Bearer mock-sp-token");
    expect(JSON.parse(result.request.body).protoLogs).toHaveLength(1);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toBe("ok");
  });

  test("normalizes host without protocol", async () => {
    await sendStartupTelemetry({
      ...defaultParams(),
      workspaceHost: "my-workspace.cloud.databricks.com",
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });

  test("strips trailing slashes from host", async () => {
    await sendStartupTelemetry({
      ...defaultParams(),
      workspaceHost: "https://my-workspace.cloud.databricks.com///",
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });

  test("handles empty plugins list", async () => {
    await sendStartupTelemetry({ ...defaultParams(), plugins: [] });

    const [, options] = fetchSpy.mock.calls[0];
    const protoLog = JSON.parse(JSON.parse(options.body).protoLogs[0]);
    expect(protoLog.entry.observability_log.entity.entity_id).toBe(
      "appkit:0.22.0:production:",
    );
  });
});
