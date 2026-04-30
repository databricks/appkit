import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { postTelemetry } from "../client";

function createMockClient(): WorkspaceClient {
  return {
    config: {
      authenticate: vi.fn(async (headers: Headers) => {
        headers.set("Authorization", "Bearer mock-sp-token");
      }),
    },
  } as unknown as WorkspaceClient;
}

const samplePayload = {
  uploadTime: 123,
  items: [],
  protoLogs: ['{"entry":{"appkit_log":{"event_name":"APP_STARTUP"}}}'],
};

const defaultOpts = () => ({
  workspaceHost: "https://my-workspace.cloud.databricks.com",
  workspaceId: "1234567890",
  client: createMockClient(),
  payload: samplePayload,
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

describe("postTelemetry", () => {
  test("POSTs to the SP-friendly /telemetry-ext endpoint", async () => {
    await postTelemetry(defaultOpts());

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
    await postTelemetry(opts);

    expect(opts.client.config.authenticate).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Databricks-Org-Id")).toBe("1234567890");
    expect(headers.get("Authorization")).toBe("Bearer mock-sp-token");
  });

  test("serializes the payload as JSON in the body", async () => {
    await postTelemetry(defaultOpts());

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual(samplePayload);
  });

  test("returns 3xx responses as-is (no automatic redirect follow)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("redirected", {
        status: 302,
        headers: { location: "/login.html?next_url=%2Ftelemetry-ext" },
      }),
    );

    const result = await postTelemetry(defaultOpts());
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(302);
    expect(result.response.body).toBe("redirected");
  });

  test("propagates fetch errors to the caller", async () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));

    await expect(postTelemetry(defaultOpts())).rejects.toThrow(
      "network failure",
    );
  });

  test("returns 4xx/5xx responses without throwing", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await postTelemetry(defaultOpts());
    expect(result.response.status).toBe(500);
    expect(result.response.body).toBe("boom");
  });

  test("propagates authentication failures", async () => {
    const opts = defaultOpts();
    (
      opts.client.config.authenticate as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("auth failed"));

    await expect(postTelemetry(opts)).rejects.toThrow("auth failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceHost is empty", async () => {
    await expect(
      postTelemetry({ ...defaultOpts(), workspaceHost: "" }),
    ).rejects.toThrow(/workspaceHost/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws when workspaceId is empty", async () => {
    await expect(
      postTelemetry({ ...defaultOpts(), workspaceId: "" }),
    ).rejects.toThrow(/workspaceId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns the dispatched request and response", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await postTelemetry(defaultOpts());
    expect(result.request.method).toBe("POST");
    expect(result.request.url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
    expect(result.response.status).toBe(200);
    expect(result.response.body).toBe("ok");
  });

  test("normalizes a host without protocol", async () => {
    await postTelemetry({
      ...defaultOpts(),
      workspaceHost: "my-workspace.cloud.databricks.com",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });

  test("strips trailing slashes from the host", async () => {
    await postTelemetry({
      ...defaultOpts(),
      workspaceHost: "https://my-workspace.cloud.databricks.com///",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.cloud.databricks.com/telemetry-ext?o=1234567890",
    );
  });
});
