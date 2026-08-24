import { inspect } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { mockServiceContext } from "../fixtures";
import { createMockWorkspaceClient, getMock } from "../mock-workspace-client";

const mk = createMockWorkspaceClient;
/** Service methods are SDK-typed, so calling an arbitrary one needs a cast. */
const svc = (client: unknown, name: string) =>
  (client as Record<string, Record<string, (...a: unknown[]) => unknown>>)[
    name
  ];

const SUCCEEDED = { status: { state: "SUCCEEDED" }, result: { data: [] } };
const TEST_USER = { id: "test-service-user", userName: "test-service-user" };

describe("createMockWorkspaceClient", () => {
  describe("the never-crash floor", () => {
    // Never-crash is the headline claim, so all nine are asserted, not sampled.
    test.each([
      ["files", "listDirectory", undefined],
      ["genie", "getMessage", undefined],
      ["jobs", "getRun", undefined],
      ["servingEndpoints", "get", undefined],
      ["warehouses", "get", { state: "RUNNING" }],
      ["warehouses", "start", undefined],
      ["statementExecution", "executeStatement", SUCCEEDED],
      ["currentUser", "me", TEST_USER],
    ])("%s.%s resolves its default", async (service, method, expected) => {
      const client = mk();
      expect(client[service as "jobs"]).toBeDefined();
      await expect(svc(client, service)[method]({})).resolves.toEqual(expected);
    });

    test("config and apiClient are reachable, and not mocks where it matters", () => {
      const client = mk();
      // Both read directly by production code — a Promise or mock here breaks it.
      expect(typeof client.config.host).toBe("string");
      expect(client.config.host).toBeTruthy();
      expect(typeof client.apiClient.userAgent()).toBe("string");
    });

    test("apiClient.request is depth-2 and destructurable", async () => {
      await expect(mk().apiClient.request({} as never)).resolves.toEqual({});
      const client = mk({
        responses: { "apiClient.request": { results: [] } },
      });
      await expect(client.apiClient.request({} as never)).resolves.toEqual({
        results: [],
      });
    });
  });

  describe("responses", () => {
    test("a declared value resolves, and overrides a default", async () => {
      const client = mk({
        responses: {
          "jobs.getRun": { state: "TERMINATED" },
          "statementExecution.executeStatement": { status: { state: "MINE" } },
        },
      });
      await expect(client.jobs.getRun({} as never)).resolves.toEqual({
        state: "TERMINATED",
      });
      await expect(
        client.statementExecution.executeStatement({} as never),
      ).resolves.toEqual({ status: { state: "MINE" } });
    });

    test("a function receives the arguments, and its rejection propagates", async () => {
      const fn = vi.fn().mockResolvedValue({ ok: true });
      await mk({ responses: { "jobs.getRun": fn } }).jobs.getRun({
        run_id: 456,
      } as never);
      expect(fn).toHaveBeenCalledWith({ run_id: 456 });

      const err = new Error("boom");
      const rejecting = mk({
        responses: { "jobs.getRun": () => Promise.reject(err) },
      });
      await expect(rejecting.jobs.getRun({} as never)).rejects.toBe(err);
    });

    test("{ defaults: false } leaves the canned paths unresolved", async () => {
      const client = mk({ defaults: false });
      await expect(
        client.statementExecution.executeStatement({} as never),
      ).resolves.toBeUndefined();
    });

    test("the config option overrides defaults and adds members", () => {
      const authenticate = vi.fn();
      const client = mk({
        config: { host: "https://custom.example.com", authenticate },
      });
      expect(client.config.host).toBe("https://custom.example.com");
      expect(client.config.authenticate).toBe(authenticate);
    });

    test('a "config.host" response stays a raw string, not a mock', () => {
      expect(
        mk({ responses: { "config.host": "https://a.b" } }).config.host,
      ).toBe("https://a.b");
    });

    test("config.authenticate stamps a header; ensureResolved resolves", async () => {
      const client = mk();
      const headers = new Headers();
      // Asserting only "was called" would pass against a mock that does nothing.
      await client.config.authenticate(headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token");
      await expect(client.config.ensureResolved()).resolves.toBeUndefined();
    });

    test("an unknown member of a seeded namespace still hits the floor", () => {
      expect(
        typeof (mk().config as never as Record<string, unknown>).nope,
      ).toBe("function");
    });
  });

  describe("memoization (call assertions depend on it)", () => {
    test("methods, namespaces, and the legacy view share one identity", () => {
      const client = mk();
      expect(client.jobs.getRun).toBe(client.jobs.getRun);
      expect(client.jobs).toBe(client.jobs);
      expect(client.toLegacyWorkspaceClient().jobs.getRun).toBe(
        client.jobs.getRun,
      );
    });

    test("un-faceted legacy services also work", async () => {
      const legacy = mk().toLegacyWorkspaceClient();
      await expect(svc(legacy, "clusters").list({})).resolves.toBeUndefined();
    });
  });

  describe("footguns", () => {
    test("a service is not thenable, so await does not hang", async () => {
      const client = mk();
      expect((client.jobs as never as { then?: unknown }).then).toBeUndefined();
      await expect(Promise.resolve(client.jobs)).resolves.toBe(client.jobs);
    });

    test("formatting and structural equality neither throw nor recurse", () => {
      const client = mk();
      // ownKeys stays default, so a service inspects as {} instead of minting a
      // mock per probed property.
      expect(inspect(client.jobs)).toBe("{}");
      expect(inspect(client.toLegacyWorkspaceClient())).toBe("{}");
      expect(inspect(client)).toContain("https://test.databricks.com");
      expect(() => JSON.stringify(client.config)).not.toThrow();
      expect(() => expect(client.jobs).toEqual({})).not.toThrow();

      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => console.log("%O", client)).not.toThrow();
      } finally {
        log.mockRestore();
      }
    });
  });

  describe("getMock", () => {
    test("mints before first use and stays stable after", async () => {
      const client = mk();
      const getRun = getMock(client, "jobs.getRun");
      expect(getRun).toHaveBeenCalledTimes(0);

      await client.jobs.getRun({ run_id: 7 } as never);
      expect(getRun).toBe(getMock(client, "jobs.getRun"));
      expect(getRun).toHaveBeenCalledWith({ run_id: 7 });
    });

    test("resolves seeded members and rejects non-function paths", () => {
      const client = mk();
      expect(getMock(client, "apiClient.request")).toBe(
        client.apiClient.request,
      );
      expect(() => getMock(client, "config.host")).toThrow(
        /not a mocked function/,
      );
      expect(() => getMock({} as never, "jobs.getRun")).toThrow(
        /not a createMockWorkspaceClient/,
      );
    });
  });

  describe("convergence with mockServiceContext (D4)", () => {
    test("the historical canned defaults are byte-identical", async () => {
      const client = mk();
      await expect(
        client.statementExecution.executeStatement({} as never),
      ).resolves.toEqual(SUCCEEDED);
      await expect(client.warehouses.get({} as never)).resolves.toEqual({
        state: "RUNNING",
      });
      await expect(
        client.warehouses.start({} as never),
      ).resolves.toBeUndefined();
    });

    test("the service and user clients are both faked, and neither crashes", async () => {
      const mock = mockServiceContext();
      try {
        // Before convergence this threw "Cannot read properties of undefined".
        await expect(
          mock.serviceContext.client.jobs.getRun({} as never),
        ).resolves.toBeUndefined();
        await expect(
          mock.serviceContext.client.statementExecution.executeStatement(
            {} as never,
          ),
        ).resolves.toMatchObject({ status: { state: "SUCCEEDED" } });

        const user = ServiceContext.createUserContext("tok", "u-1", "alice");
        await expect(
          user.client.jobs.getRun({} as never),
        ).resolves.toBeUndefined();
      } finally {
        mock.restore();
      }
    });
  });

  /**
   * Enforced by `tsc --noEmit`, not at runtime: a `@ts-expect-error` that stops
   * being an error fails the typecheck.
   */
  describe("compile-time contract", () => {
    test("unknown members and misspelled methods are compile errors", () => {
      const client = mk();

      // @ts-expect-error - `jbos` is not a facade member
      expect(client.jbos).toBeUndefined();
      // @ts-expect-error - `getRunz` is not a jobs method
      void client.jobs.getRunz;
      // @ts-expect-error - `getMessagez` is not a genie method
      void client.genie.getMessagez;

      // `host` is `string | undefined` in the SDK, so the honest claim is that it
      // narrows to a string — not that it is non-optional.
      const host = client.config.host;
      expect(typeof host).toBe("string");

      const getRun = getMock(client, "jobs.getRun");
      getRun.mockResolvedValue({ state: "TERMINATED" });
      expect(getRun.mock.calls).toEqual([]);
    });
  });
});
