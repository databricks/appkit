import type { LakebasePoolConfig } from "@databricks/lakebase";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { assertEndpointHostMatches } from "../endpoint-host";

type Client = NonNullable<LakebasePoolConfig["workspaceClient"]>;

// Unique pairs keep concurrent checks from different tests independent.
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

describe("assertEndpointHostMatches", () => {
  test("rejects a confirmed mismatch with both hosts before a pool is allocated", async () => {
    const { endpoint, host } = names();
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com" }),
    );
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).rejects.toThrow(host);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/2.0/postgres/${endpoint}`,
        method: "GET",
      }),
      expect.anything(),
    );
    expect(warn).not.toHaveBeenCalled();
    const output = errorLog.mock.calls.flat().map(String).join(" ");
    expect(output).toContain(host);
    expect(output).toContain(endpoint);
    expect(output).toContain("ep-expected.database.example.com");
  });

  test("reads the endpoint and host from the environment", async () => {
    const { endpoint, host } = names();
    vi.stubEnv("LAKEBASE_ENDPOINT", endpoint);
    vi.stubEnv("PGHOST", host);
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-other.database.example.com" }),
    );

    await expect(
      assertEndpointHostMatches({ workspaceClient: client }),
    ).rejects.toThrow("ep-other.database.example.com");

    expect(request).toHaveBeenCalledOnce();
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

    await assertEndpointHostMatches({
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
    [
      "an endpoint with query characters",
      { endpoint: "projects/p/branches/b/endpoints/primary?token=private" },
    ],
    [
      "an endpoint with a trailing newline",
      { endpoint: "projects/p/branches/b/endpoints/primary\n" },
    ],
    ["a host with a newline", { host: "ep.example.com\nsecret" }],
    ["a host with a trailing newline", { host: "ep.example.com\n" }],
  ])("sends no request with %s", async (_label, override) => {
    const { request, client } = clientAnswering(endpointWith({}));

    await assertEndpointHostMatches({
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
  ])("continues startup but warns when %s", async (_label, answer) => {
    const { endpoint, host } = names();
    const request = vi.fn(async () => answer());
    const client = { apiClient: { request } } as unknown as Client;

    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).resolves.toBeUndefined();
    expect(warnings()).toContain("Could not verify PGHOST");
  });

  test("does not log or trust a malformed host in the endpoint response", async () => {
    const { endpoint, host } = names();
    const { client } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com\nprivate row" }),
    );
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).resolves.toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnings()).toContain("Could not verify PGHOST");
    expect(warnings()).not.toContain("private row");
  });

  test("warns when the endpoint no longer exists", async () => {
    const { endpoint, host } = names();
    const request = vi.fn(async () => {
      throw Object.assign(new Error("branch id not found"), {
        statusCode: 404,
      });
    });
    const client = { apiClient: { request } } as unknown as Client;

    await assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });

    expect(warnings()).toContain(`${endpoint} was not found`);
    expect(warnings()).not.toContain("branch id not found");
  });

  test("gives up on a slow lookup without holding startup", async () => {
    vi.useFakeTimers();
    const { endpoint, host } = names();
    const { client } = clientAnswering(new Promise(() => undefined));

    const check = assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(check).resolves.toBeUndefined();
    expect(warnings()).toContain("Could not verify PGHOST");
  });

  test("aborts the outbound SDK request when the three-second deadline expires", async () => {
    vi.useFakeTimers();
    const { endpoint, host } = names();
    const request = vi.fn(
      async (_request: unknown, _context?: unknown) =>
        new Promise(() => undefined),
    );
    const client = { apiClient: { request } } as unknown as Client;

    const check = assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await check;

    const context = request.mock.calls[0]?.[1] as
      | { cancellationToken?: { isCancellationRequested: boolean } }
      | undefined;
    expect(context?.cancellationToken?.isCancellationRequested).toBe(true);
  });

  test("retries after an API failure instead of caching an unverified host", async () => {
    const { endpoint, host } = names();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("403 Forbidden"))
      .mockResolvedValueOnce(
        endpointWith({ host: "ep-expected.database.example.com" }),
      );
    const client = { apiClient: { request } } as unknown as Client;

    await assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).rejects.toThrow("ep-expected.database.example.com");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("rechecks after a successful lookup in case the endpoint host changes", async () => {
    const { endpoint, host } = names();
    const request = vi
      .fn()
      .mockResolvedValueOnce(endpointWith({ host }))
      .mockResolvedValueOnce(
        endpointWith({ host: "ep-new.database.example.com" }),
      );
    const client = { apiClient: { request } } as unknown as Client;

    await assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).rejects.toThrow("ep-new.database.example.com");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("does not reuse an inaccessible client's check for another identity", async () => {
    const { endpoint, host } = names();
    const denied = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const { request: allowed, client: allowedClient } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com" }),
    );
    const deniedClient = {
      apiClient: { request: denied },
    } as unknown as Client;

    const results = await Promise.allSettled([
      assertEndpointHostMatches({
        endpoint,
        host,
        workspaceClient: deniedClient,
      }),
      assertEndpointHostMatches({
        endpoint,
        host,
        workspaceClient: allowedClient,
      }),
    ]);

    expect(results.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(allowed).toHaveBeenCalledOnce();
  });

  test("shares one lookup between pools for the same endpoint and host", async () => {
    const { endpoint, host } = names();
    const { request, client } = clientAnswering(
      endpointWith({ host: "ep-expected.database.example.com" }),
    );

    const results = await Promise.allSettled([
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(results.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });
});

// AppKit passes its modular workspace client (with `request()`) to lakebase,
// so in apps the lookup goes through `request`, not the legacy `apiClient`.
describe("assertEndpointHostMatches with the modular request() client", () => {
  function modularClient(
    impl: (req: { signal?: AbortSignal }) => Promise<Response>,
  ) {
    const request = vi.fn(impl);
    return { request, client: { request } as unknown as Client };
  }

  test("rejects a mismatch read through request()", async () => {
    const { endpoint, host } = names();
    const { request, client } = modularClient(async () =>
      Response.json(endpointWith({ host: "ep-expected.database.example.com" })),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      assertEndpointHostMatches({ endpoint, host, workspaceClient: client }),
    ).rejects.toThrow(host);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: `/api/2.0/postgres/${endpoint}`,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test("warns when request() reports the endpoint no longer exists (404)", async () => {
    const { endpoint, host } = names();
    const { client } = modularClient(async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    });

    await assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    expect(warnings()).toContain("was not found");
  });

  test("aborts the request() lookup when the deadline expires", async () => {
    vi.useFakeTimers();
    const { endpoint, host } = names();
    let seen: AbortSignal | undefined;
    const { client } = modularClient(
      (req) =>
        new Promise<Response>(() => {
          seen = req.signal;
        }),
    );

    const check = assertEndpointHostMatches({
      endpoint,
      host,
      workspaceClient: client,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await check;
    expect(seen?.aborted).toBe(true);
    expect(warnings()).toContain("timed out");
  });
});
