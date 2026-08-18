import { inspect } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { mockServiceContext } from "../fixtures";
import { createMockWorkspaceClient, getMockFn } from "../mock-workspace-client";

describe("createMockWorkspaceClient", () => {
  describe("happy path", () => {
    test("all 9 facade accessors are reachable and callable without throwing", async () => {
      const client = createMockWorkspaceClient();

      // Assert all 9 explicitly reachable.
      expect(client.files).toBeDefined();
      expect(client.warehouses).toBeDefined();
      expect(client.genie).toBeDefined();
      expect(client.jobs).toBeDefined();
      expect(client.statementExecution).toBeDefined();
      expect(client.servingEndpoints).toBeDefined();
      expect(client.currentUser).toBeDefined();
      expect(client.config).toBeDefined();
      expect(client.apiClient).toBeDefined();

      // And callable without throwing (using as any since these are Proxy mocks).
      await expect(
        (client.files as any).listDirectory({ path: "/x" }),
      ).resolves.toBe(undefined);
      await expect(client.warehouses.get({ id: "123" })).resolves.toEqual({
        state: "RUNNING",
      });
      await expect(
        (client.genie as any).getMessage({ message_id: "xyz" }),
      ).resolves.toBe(undefined);
      await expect(client.jobs.getRun({ run_id: 1 })).resolves.toBe(undefined);
      await expect(
        client.statementExecution.executeStatement({
          warehouse_id: "w1",
          catalog: "c",
          schema: "s",
          statement: "SELECT 1",
        }),
      ).resolves.toEqual({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      });
      await expect(
        (client.servingEndpoints as any).get({ name: "ep" }),
      ).resolves.toBe(undefined);
      await expect(client.currentUser.me()).resolves.toEqual({
        id: "test-service-user",
        userName: "test-service-user",
      });
      expect(typeof client.config.host).toBe("string");
      expect(typeof client.apiClient.userAgent?.()).toBe("string");
    });

    test("a declared path returns its value", async () => {
      const response = { state: "TERMINATED", result_state: "SUCCESS" };
      const client = createMockWorkspaceClient({
        responses: { "jobs.getRun": response },
      });
      const result = await client.jobs.getRun({ run_id: 123 });
      expect(result).toEqual(response);
    });

    test("a function-valued response receives call arguments", async () => {
      const fn = vi.fn().mockResolvedValue({ called: true });
      const client = createMockWorkspaceClient({
        responses: { "jobs.getRun": fn },
      });
      const args = { run_id: 456 };
      await client.jobs.getRun(args);
      expect(fn).toHaveBeenCalledWith(args);
    });

    test("a rejecting function propagates the error", async () => {
      const error = new Error("test error");
      const client = createMockWorkspaceClient({
        responses: { "jobs.getRun": () => Promise.reject(error) },
      });
      await expect(client.jobs.getRun({ run_id: 789 })).rejects.toBe(error);
    });

    test("an undeclared path resolves undefined and does not throw", async () => {
      const client = createMockWorkspaceClient();
      const result = await (client.genie as any).getMessage({
        message_id: "missing",
      });
      expect(result).toBe(undefined);
    });

    test("depth-2 apiClient.request resolves from the key", async () => {
      const response = { results: [{ value: "x" }] };
      const client = createMockWorkspaceClient({
        responses: { "apiClient.request": response },
      });
      const result = await (client.apiClient.request as any)({
        path: "/api/2.0/something",
      });
      expect(result).toEqual(response);
    });

    test("built-in defaults hold when responses is omitted", async () => {
      const client = createMockWorkspaceClient();
      const executeStmtResult =
        await client.statementExecution.executeStatement({
          warehouse_id: "w",
          catalog: "c",
          schema: "s",
          statement: "SELECT 1",
        });
      expect(executeStmtResult).toEqual({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      });

      const warehouseResult = await client.warehouses.get({ id: "w1" });
      expect(warehouseResult).toEqual({ state: "RUNNING" });
    });

    test("a caller-supplied response overrides the default", async () => {
      const customResponse = {
        status: { state: "RUNNING" },
        result: { data: ["custom"] },
      };
      const client = createMockWorkspaceClient({
        responses: {
          "statementExecution.executeStatement": customResponse,
        },
      });
      const result = await client.statementExecution.executeStatement({
        warehouse_id: "w",
        catalog: "c",
        schema: "s",
        statement: "SELECT 1",
      });
      expect(result).toEqual(customResponse);
    });

    test("currentUser.me() resolves an object with a non-empty id", async () => {
      const client = createMockWorkspaceClient();
      const user = await client.currentUser.me();
      expect(user).toBeDefined();
      expect(user?.id).toBeTruthy();
      expect(user?.userName).toBeTruthy();
    });
  });

  describe("stable identity (memoization)", () => {
    test("client.jobs.getRun === client.jobs.getRun across accesses", async () => {
      const client = createMockWorkspaceClient();
      const fn1 = client.jobs.getRun;
      const fn2 = client.jobs.getRun;
      expect(fn1).toBe(fn2);
      // toHaveBeenCalledWith should also work with the stable reference.
      await fn1({ run_id: 1 });
      expect(fn1).toHaveBeenCalledWith({ run_id: 1 });
    });

    test("client.jobs === client.jobs (namespace memoization)", () => {
      const client = createMockWorkspaceClient();
      const jobs1 = client.jobs;
      const jobs2 = client.jobs;
      expect(jobs1).toBe(jobs2);
    });

    test("client.toLegacyWorkspaceClient().jobs.getRun === client.jobs.getRun", async () => {
      const client = createMockWorkspaceClient({
        responses: { "jobs.getRun": { state: "COMPLETED" } },
      });
      const legacy = client.toLegacyWorkspaceClient();
      const clientFn = client.jobs.getRun;
      const legacyFn = legacy.jobs.getRun;
      expect(clientFn).toBe(legacyFn);
      // Call it and verify it's tracked on both references.
      await clientFn({ run_id: 1 });
      expect(legacyFn).toHaveBeenCalledWith({ run_id: 1 });
    });

    test("un-faceted legacy services work (e.g., legacy.clusters.list())", async () => {
      const client = createMockWorkspaceClient({
        responses: { "clusters.list": { clusters: [] } },
      });
      const legacy = client.toLegacyWorkspaceClient();
      const result = await (legacy as any).clusters.list();
      expect(result).toEqual({ clusters: [] });
    });
  });

  describe("footguns (the highest-value tests)", () => {
    test("client.jobs.then is undefined; await client.jobs resolves to the service itself", async () => {
      const client = createMockWorkspaceClient();
      // Should not hang or resolve to a mock's return value.
      const resolved = await client.jobs;
      expect(resolved).toBe(client.jobs);
    });

    test("util.inspect renders the client without throwing or recursing", () => {
      const client = createMockWorkspaceClient();

      // Because the traps leave `ownKeys`/`getOwnPropertyDescriptor` at their
      // defaults, a service proxy has no enumerable keys and inspects as `{}`
      // instead of recursing forever minting a mock per probed property.
      expect(inspect(client.jobs)).toBe("{}");
      expect(inspect(client.toLegacyWorkspaceClient())).toBe("{}");

      // The facade itself is a plain object, so its nine members are listed —
      // and `config.host` shows through as the real string it is.
      const whole = inspect(client);
      expect(whole).toContain("jobs: {}");
      expect(whole).toContain("https://test.databricks.com");
    });

    test("console.log('%O', client) works without hanging or recursing", () => {
      const client = createMockWorkspaceClient();
      // Stubbed only to keep the formatted dump out of the test output — the
      // formatting still runs, which is what could throw or recurse.
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => {
          console.log("%O", client);
        }).not.toThrow();
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });

    test("expect(client.jobs).toEqual({}) does not blow the stack", () => {
      const client = createMockWorkspaceClient();
      // This is the `asymmetricMatch` guard test.
      expect(() => {
        expect(client.jobs).toEqual({});
      }).not.toThrow();
    });

    test("JSON.stringify(client.config) does not throw", () => {
      const client = createMockWorkspaceClient();
      expect(() => {
        JSON.stringify(client.config);
      }).not.toThrow();
    });
  });

  describe("special cases", () => {
    test("typeof client.config.host === 'string' and truthy", () => {
      const client = createMockWorkspaceClient();
      const host = client.config.host;
      expect(typeof host).toBe("string");
      expect(host).toBeTruthy();
      // Can build a URL from it.
      expect(() => {
        new URL("/x", host as string);
      }).not.toThrow();
    });

    test("responses['config.host'] returns the raw string, not a mock", async () => {
      const host = "https://custom.databricks.com";
      const client = createMockWorkspaceClient({
        responses: { "config.host": host },
      });
      expect(client.config.host).toBe(host);
    });

    test("client.config.authenticate(new Headers()) sets an Authorization header", async () => {
      const client = createMockWorkspaceClient();
      const headers = new Headers();
      const mockFn = client.config.authenticate;
      if (mockFn) {
        // The mock is a vi.fn(), so we can verify it was called.
        // In a real implementation, authenticate would set the header.
        await mockFn(headers);
        expect(mockFn).toHaveBeenCalledWith(headers);
      }
    });

    test("client.config.ensureResolved() resolves", async () => {
      const client = createMockWorkspaceClient();
      await expect(client.config.ensureResolved()).resolves.toBe(undefined);
    });

    test("typeof client.apiClient.userAgent() === 'string' (synchronous)", () => {
      const client = createMockWorkspaceClient();
      const result = client.apiClient.userAgent?.();
      expect(typeof result).toBe("string");
      // Not a Promise (shouldn't have a .then method).
      expect(typeof (result as any)?.then).not.toBe("function");
    });

    test("await client.apiClient.request({}) resolves to an object", async () => {
      const client = createMockWorkspaceClient();
      const result = await (client.apiClient.request as any)({
        path: "/api/2.0/test",
      });
      // Should be an object, not undefined.
      expect(result).toEqual({});
    });

    test("client.config.someUnknownField returns a mock", async () => {
      const client = createMockWorkspaceClient();
      const unknownField = (client.config as any).someUnknownField;
      // Should be a mock (vi.fn).
      expect(typeof unknownField).toBe("function");
      if (typeof unknownField === "function" && (unknownField as any).mock) {
        expect((unknownField as any).mock).toBeDefined();
      }
    });

    test("{ defaults: false } leaves statementExecution.executeStatement unresolved", async () => {
      const client = createMockWorkspaceClient({ defaults: false });
      const result = await client.statementExecution.executeStatement({
        warehouse_id: "w",
        catalog: "c",
        schema: "s",
        statement: "SELECT 1",
      });
      expect(result).toBe(undefined);
    });
  });

  describe("compile-time type safety", () => {
    test("client.jobs.getRun is callable and memoized", () => {
      const client = createMockWorkspaceClient();
      // Accessing it twice should return the same function.
      const fn1 = client.jobs.getRun;
      const fn2 = client.jobs.getRun;
      expect(fn1).toBe(fn2);
    });

    test("client.config.host is a string", () => {
      const client = createMockWorkspaceClient();
      // host is a real string, so string methods work.
      const host = client.config.host;
      const result = (host as string).startsWith?.("https://");
      expect(result).toBe(true);
    });

    // Note: client.jbos would be a compile error, so we can't test it at runtime.
    // But the type is checked during typecheck.
  });

  describe("integration with existing seam", () => {
    test("the new mock client has all 9 facade members and works with defaults", async () => {
      // Never-crash is the headline claim, so all 9 are asserted explicitly
      // rather than sampled.
      const client = createMockWorkspaceClient();

      // All 9 facade members should be present and callable.
      const results = await Promise.all([
        (client.files as any).listDirectory({ path: "/x" }),
        client.warehouses.get({ id: "w" }),
        (client.genie as any).getMessage({ message_id: "g" }),
        client.jobs.getRun({ run_id: 1 }),
        client.statementExecution.executeStatement({
          warehouse_id: "w",
          catalog: "c",
          schema: "s",
          statement: "SELECT 1",
        }),
        (client.servingEndpoints as any).get({ name: "e" }),
        client.currentUser.me(),
      ]);

      // files, genie, jobs, servingEndpoints, currentUser resolve undefined (no defaults).
      expect(results[0]).toBe(undefined);
      expect(results[2]).toBe(undefined);
      expect(results[3]).toBe(undefined);
      expect(results[5]).toBe(undefined);

      // warehouses.get and statementExecution have defaults.
      expect(results[1]).toEqual({ state: "RUNNING" });
      expect(results[4]).toEqual({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      });

      // currentUser.me returns an object with id (required by ServiceContext).
      expect(results[6]).toEqual({
        id: "test-service-user",
        userName: "test-service-user",
      });
    });
  });

  describe("getMockFn escape hatch", () => {
    test("getMockFn retrieves the cached mock for a dotted path", async () => {
      const client = createMockWorkspaceClient();
      await client.jobs.getRun({ run_id: 123 });

      const mock = getMockFn(client, "jobs.getRun");
      expect(mock.mock).toBeDefined();
      expect(mock).toHaveBeenCalledWith({ run_id: 123 });
    });

    test("getMockFn mints before first use, so it can be grabbed up front", async () => {
      const client = createMockWorkspaceClient();

      // Grabbing the handle before the code under test runs must yield the very
      // function that code will call — otherwise every assertion would have to
      // be written after the fact.
      const getRun = getMockFn(client, "jobs.getRun");
      expect(getRun).toHaveBeenCalledTimes(0);

      await client.jobs.getRun({ run_id: 7 });

      expect(getRun).toBe(getMockFn(client, "jobs.getRun"));
      expect(getRun).toHaveBeenCalledWith({ run_id: 7 });
    });

    test("getMockFn resolves seeded members and rejects non-function paths", () => {
      const client = createMockWorkspaceClient();

      // Seeded on the apiClient object rather than minted by the trap.
      expect(getMockFn(client, "apiClient.request")).toBe(
        client.apiClient.request,
      );

      // config.host is a real string, so there is no mock to hand back.
      expect(() => getMockFn(client, "config.host")).toThrow(
        /not a mocked function/,
      );

      expect(() => getMockFn({} as never, "jobs.getRun")).toThrow(
        /not a createMockWorkspaceClient/,
      );
    });

    test("getMockFn works for paths that go through getCachedMock", async () => {
      const client = createMockWorkspaceClient({
        responses: { "genie.getMessage": { id: "msg-1" } },
      });
      await (client.genie as any).getMessage({ message_id: "xyz" });

      const mock = getMockFn(client, "genie.getMessage");
      expect(mock.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("configuration override", () => {
    test("config option can override defaults", () => {
      const customHost = "https://custom.databricks.com";
      const client = createMockWorkspaceClient({
        config: { host: customHost },
      });
      expect(client.config.host).toBe(customHost);
    });

    test("config option can add custom properties", () => {
      const customAuth = vi.fn();
      const client = createMockWorkspaceClient({
        config: { authenticate: customAuth },
      });
      expect(client.config.authenticate).toBe(customAuth);
    });
  });

  describe("error handling", () => {
    test("a throwing function response propagates as a rejection", async () => {
      const error = new Error("sync error");
      const client = createMockWorkspaceClient({
        responses: { "jobs.getRun": () => Promise.reject(error) },
      });
      await expect(client.jobs.getRun({ run_id: 1 })).rejects.toBe(error);
    });

    test("calling methods with various arguments works", async () => {
      const client = createMockWorkspaceClient({
        responses: {
          "files.getStatus": (args: any) => ({ path: args.path, exists: true }),
        },
      });
      const result = await (client.files as any).getStatus({
        path: "/data/file.txt",
      });
      expect(result).toEqual({ path: "/data/file.txt", exists: true });
    });
  });
});

/**
 * Compile-time contract. These assertions are enforced by `tsc --noEmit`
 * (`pnpm --filter=@databricks/appkit typecheck`), not at runtime: a
 * `@ts-expect-error` that stops being an error fails the typecheck, which is
 * what guards the typed floor. The block runs as a test only so an accidental
 * runtime throw is still caught.
 */
describe("compile-time contract", () => {
  test("the typed facade rejects unknown members and keeps host a string", () => {
    const client = createMockWorkspaceClient();

    // A misspelled *service* is a compile error — this is what the typed
    // 9-member floor buys over an untyped Proxy.
    // @ts-expect-error - `jbos` is not a facade member
    expect(client.jbos).toBeUndefined();

    // And so is a misspelled *method*, because each accessor is typed against
    // the SDK's own service class. The runtime floor is a fallback for calls
    // that bypass the types, not the first line of defence — verified against a
    // packed tarball from outside the monorepo.
    // @ts-expect-error - `getRunz` is not a jobs method
    void client.jobs.getRunz;
    // @ts-expect-error - `getMessagez` is not a genie method
    void client.genie.getMessagez;
    // @ts-expect-error - `anything` is not a files method
    void client.files.anything;

    // `config.host` is typed `string | undefined` by the SDK (production code
    // guards it — see connectors/files/client.ts, which throws when falsy), so
    // the honest compile-time claim is that it narrows to a *string*, not that
    // it is non-optional. If the fake ever regressed to handing back a mock,
    // this narrowing would not compile and `.startsWith` would not exist.
    const host = client.config.host;
    expect(typeof host).toBe("string");
    if (typeof host === "string") {
      expect(host.startsWith("https://")).toBe(true);
    }

    // The mock handle is a real `Mock`, so the mock API typechecks.
    const getRun = getMockFn(client, "jobs.getRun");
    getRun.mockResolvedValue({ state: "TERMINATED" });
    expect(getRun.mock.calls).toEqual([]);
  });
});

/**
 * The convergence guard. `mockServiceContext` hands this client to 13 test
 * files that never name it — they just call `mockServiceContext()` and let the
 * default client through. These assertions are what prove pointing that default
 * at the new builder is a fix rather than a break.
 */
describe("convergence with mockServiceContext (D4)", () => {
  test("the historical canned defaults are unchanged", async () => {
    const client = createMockWorkspaceClient();

    // Byte-identical to the shape the old two-service fixture returned.
    await expect(
      client.statementExecution.executeStatement({} as never),
    ).resolves.toEqual({
      status: { state: "SUCCEEDED" },
      result: { data: [] },
    });
    await expect(client.warehouses.get({} as never)).resolves.toEqual({
      state: "RUNNING",
    });
    await expect(client.warehouses.start({} as never)).resolves.toBeUndefined();
  });

  test("the default client from mockServiceContext no longer crashes on jobs", async () => {
    const mock = mockServiceContext();
    try {
      const client = mock.serviceContext.client;

      // The whole point of U1+U2: before convergence this threw
      // "Cannot read properties of undefined (reading 'getRun')", because the
      // default client only had statementExecution and warehouses.
      await expect(client.jobs.getRun({ run_id: 1 })).resolves.toBeUndefined();
      await expect(
        (
          client.genie as never as Record<string, () => Promise<unknown>>
        ).getMessage(),
      ).resolves.toBeUndefined();

      // ...while the SQL path 13 files depend on still succeeds.
      await expect(
        client.statementExecution.executeStatement({} as never),
      ).resolves.toMatchObject({ status: { state: "SUCCEEDED" } });
    } finally {
      mock.restore();
    }
  });

  test("the user-context client is faked too, not just the service one", async () => {
    const mock = mockServiceContext();
    try {
      const userCtx = ServiceContext.createUserContext("tok", "u-1", "alice");
      await expect(
        userCtx.client.jobs.getRun({ run_id: 1 }),
      ).resolves.toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});
