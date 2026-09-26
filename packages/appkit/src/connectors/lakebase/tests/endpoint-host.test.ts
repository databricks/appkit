import type { LakebasePoolConfig } from "@databricks/lakebase";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { warnOnEndpointHostMismatch } from "../endpoint-host";

type Client = NonNullable<LakebasePoolConfig["workspaceClient"]>;

// Checks are shared per endpoint and host for the process, so every test
// names its own pair.
let sequence = 0;
function names() {
  sequence += 1;
  return {
    endpoint: `projects/p${sequence}/branches/b/endpoints/primary`,
    host: `ep-configured-${sequence}.database.example.com`,
  };
}

function clientAnswering(response: unknown | Promise<unknown>) {
  const request = vi.fn(async () => response);
  return { request, client: { apiClient: { request } } as unknown as Client };
}

const endpointWith = (hosts: Record<string, string>) => ({
  name: "ignored",
  status: { hosts },
});

let warn: ReturnType<typeof vi.spyOn>;
const warnings = () => warn.mock.calls.flat().map(String).join(" ");

beforeEach(() => {
  vi.stubEnv("LAKEBASE_ENDPOINT", "");
  vi.stubEnv("PGHOST", "");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("warnOnEndpointHostMismatch", () => {
  test("warns with both hosts when PGHOST serves another endpoint", async () => {
    const { endpoint, host } = names();
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com" }),
    );

    await warnOnEndpointHostMismatch({
      endpoint,
      host,
      workspaceClient: client,
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/2.0/postgres/${endpoint}`,
        method: "GET",
      }),
    );
    expect(warnings()).toContain(host);
    expect(warnings()).toContain(endpoint);
    expect(warnings()).toContain("ep-expected.database.example.com");
  });

  test("reads the endpoint and host from the environment", async () => {
    const { endpoint, host } = names();
    vi.stubEnv("LAKEBASE_ENDPOINT", endpoint);
    vi.stubEnv("PGHOST", host);
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-other.database.example.com" }),
    );

    await warnOnEndpointHostMismatch({ workspaceClient: client });

    expect(request).toHaveBeenCalledOnce();
    expect(warnings()).toContain(host);
  });

  test.each([
    ["the read-write host", (host: string) => ({ host: host.toUpperCase() })],
    [
      "a read-only host",
      (host: string) => ({
        host: "ep-primary.database.example.com",
        read_only_host: host,
      }),
    ],
  ])("stays quiet when PGHOST is %s", async (_label, hostsFor) => {
    const { endpoint, host } = names();
    const { client } = clientAnswering(endpointWith(hostsFor(host)));

    await warnOnEndpointHostMismatch({
      endpoint,
      host,
      workspaceClient: client,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ["no endpoint", { endpoint: undefined }],
    ["no host", { host: undefined }],
    ["no workspace client", { workspaceClient: undefined }],
    [
      "an endpoint that is not a resource name",
      { endpoint: "../../jobs/list" },
    ],
  ])("sends no request with %s", async (_label, override) => {
    const { request, client } = clientAnswering(endpointWith({}));

    await warnOnEndpointHostMismatch({
      ...names(),
      workspaceClient: client,
      ...override,
    });

    expect(request).not.toHaveBeenCalled();
  });

  test.each([
    ["the lookup fails", () => Promise.reject(new Error("403 Forbidden"))],
    ["the endpoint lists no hosts", () => endpointWith({})],
    ["the response has no status", () => ({ name: "x" })],
  ])("never throws or warns when %s", async (_label, answer) => {
    const { endpoint, host } = names();
    const request = vi.fn(async () => answer());
    const client = { apiClient: { request } } as unknown as Client;

    await expect(
      warnOnEndpointHostMismatch({ endpoint, host, workspaceClient: client }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the endpoint no longer exists", async () => {
    const { endpoint, host } = names();
    const request = vi.fn(async () => {
      throw Object.assign(new Error("branch id not found"), {
        statusCode: 404,
      });
    });
    const client = { apiClient: { request } } as unknown as Client;

    await warnOnEndpointHostMismatch({
      endpoint,
      host,
      workspaceClient: client,
    });

    expect(warnings()).toContain(`${endpoint} was not found`);
    expect(warnings()).toContain("branch id not found");
  });

  test("gives up on a slow lookup without holding startup", async () => {
    vi.useFakeTimers();
    const { endpoint, host } = names();
    const { client } = clientAnswering(new Promise(() => undefined));

    const check = warnOnEndpointHostMismatch({
      endpoint,
      host,
      workspaceClient: client,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(check).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test("shares one lookup between pools for the same endpoint and host", async () => {
    const { endpoint, host } = names();
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com" }),
    );

    await Promise.all([
      warnOnEndpointHostMismatch({ endpoint, host, workspaceClient: client }),
      warnOnEndpointHostMismatch({ endpoint, host, workspaceClient: client }),
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});
