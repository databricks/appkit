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
      ["genie", "genieGetConversationMessage", undefined],
      ["jobs", "getRun", undefined],
      ["warehouses", "getWarehouse", { state: "RUNNING" }],
      ["warehouses", "startWarehouse", undefined],
      ["statementExecution", "executeStatement", SUCCEEDED],
      ["currentUser", "me", TEST_USER],
    ])("%s.%s resolves its default", async (service, method, expected) => {
      const client = mk();
      expect(client[service as "jobs"]).toBeDefined();
      await expect(svc(client, service)[method]({})).resolves.toEqual(expected);
    });

    test("the auth seam is reachable: host is a real string, request a Response", async () => {
      const client = mk();
      const host = await client.getHost();
      expect(typeof host).toBe("string");
      expect(host).toBeTruthy();
      const res = await client.request({ method: "GET", path: "/x" });
      await expect(res.json()).resolves.toEqual({});
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

    test("the config option seeds the host", async () => {
      const client = mk({ config: { host: "https://custom.example.com" } });
      await expect(client.getHost()).resolves.toBe(
        "https://custom.example.com",
      );
    });

    test('a "config.host" response seeds the host as a raw string', async () => {
      await expect(
        mk({ responses: { "config.host": "https://a.b" } }).getHost(),
      ).resolves.toBe("https://a.b");
    });

    test("authenticate stamps a header", async () => {
      const client = mk();
      const headers = new Headers();
      // Asserting only "was called" would pass against a mock that does nothing.
      await client.authenticate(headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    });
  });

  describe("memoization (call assertions depend on it)", () => {
    test("methods and namespaces share one identity", () => {
      const client = mk();
      expect(client.jobs.getRun).toBe(client.jobs.getRun);
      expect(client.jobs).toBe(client.jobs);
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
      expect(() => inspect(client)).not.toThrow();
      expect(() => JSON.stringify(client)).not.toThrow();
      expect(() => expect(client.jobs).toEqual({})).not.toThrow();

      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => console.log("%O", client)).not.toThrow();
      } finally {
        log.mockRestore();
      }
    });
  });

  describe("strict", () => {
    test("an undeclared call throws, naming the path", async () => {
      const client = mk({ strict: true, responses: { "jobs.getRun": {} } });
      await expect(client.jobs.getRun({} as never)).resolves.toEqual({});
      expect(() => client.jobs.cancelRun({} as never)).toThrow(
        /"jobs.cancelRun" was called with no declared response/,
      );
    });

    test("it throws on call, not on mint, so getMock still hands back a handle", () => {
      // Grabbing the handle before the code under test runs is the normal
      // pattern; minting must not be what explodes.
      const client = mk({ strict: true });
      const fn = getMock(client, "jobs.cancelRun");
      expect(fn).toHaveBeenCalledTimes(0);
      expect(() => fn({} as never)).toThrow(/no declared response/);
    });

    test("the canned defaults still count as declared", async () => {
      // Otherwise `strict` would break every harness boot, which reads
      // currentUser.me through this client.
      const client = mk({ strict: true });
      await expect(client.currentUser.me({} as never)).resolves.toMatchObject({
        id: "test-service-user",
      });
    });

    test("with defaults: false even the canned paths are undeclared", async () => {
      const client = mk({ strict: true, defaults: false });
      expect(() => client.currentUser.me({} as never)).toThrow(
        /no declared response/,
      );
    });

    test("off by default — an undeclared call still resolves undefined", async () => {
      await expect(mk().jobs.cancelRun({} as never)).resolves.toBeUndefined();
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

    test("resolves seam members and rejects non-clients", () => {
      const client = mk();
      expect(getMock(client, "request")).toBe(client.request);
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
      await expect(
        client.warehouses.getWarehouse({} as never),
      ).resolves.toEqual({
        state: "RUNNING",
      });
      await expect(
        client.warehouses.startWarehouse({} as never),
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

      const host: Promise<string> = client.getHost();
      void host;

      const getRun = getMock(client, "jobs.getRun");
      getRun.mockResolvedValue({ state: "TERMINATED" });
      expect(getRun.mock.calls).toEqual([]);
    });
  });
});
