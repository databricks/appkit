import type { IAppRouter, PluginManifest } from "shared";
import { describe, expect, test } from "vitest";

import { getWorkspaceClient } from "../../context";
import { Plugin, toPlugin } from "../../plugin";
import type { WorkspaceClient } from "../../workspace-client";
import { createTestApp } from "../create-test-app";
import { getMockFn } from "../mock-workspace-client";

/**
 * Coverage for the harness itself. Nothing here is mocked beyond the workspace
 * client the harness installs: these boots bind real sockets and run the real
 * Express stack, because that is the claim being tested.
 */

/** Builds a manifest with the fields the loader validates. */
function manifest(
  name: string,
  extra: Record<string, unknown> = {},
): PluginManifest {
  return {
    name,
    displayName: name,
    version: "0.0.0",
    description: `${name} test plugin`,
    resources: { required: [] },
    ...extra,
  } as unknown as PluginManifest;
}

/** Serves JSON, echoes bodies, and reports what it saw of the client. */
class EchoPlugin extends Plugin {
  static manifest = manifest("echo");

  /** The client this plugin resolved at request time. */
  seenClient: WorkspaceClient | undefined;

  injectRoutes(router: IAppRouter): void {
    router.get("/ping", async (_req, res) => {
      res.json({ pong: true });
    });

    router.post("/echo", async (req, res) => {
      res.json({
        received: req.body,
        contentType: req.headers["content-type"],
      });
    });

    router.get("/whoami", async (req, res) => {
      res.json({
        user: req.headers["x-forwarded-user"] ?? null,
        token: req.headers["x-forwarded-access-token"] ?? null,
        custom: req.headers["x-custom"] ?? null,
      });
    });

    router.get("/from-client", async (_req, res) => {
      // Reaches the data plane exactly the way a real plugin does.
      const client = getWorkspaceClient();
      this.seenClient = client;
      const run = await client.jobs.getRun({ run_id: 1 } as never);
      res.json({ run });
    });

    router.get("/client-identity", async (_req, res) => {
      this.seenClient = getWorkspaceClient();
      res.json({ ok: true });
    });

    router.get("/boom", async () => {
      throw new Error("handler exploded");
    });

    router.put("/put", async (req, res) => res.json({ m: "PUT", b: req.body }));
    router.patch("/patch", async (req, res) =>
      res.json({ m: "PATCH", b: req.body }),
    );
    router.delete("/del", async (_req, res) => res.json({ m: "DELETE" }));
  }

  exports() {
    return { seenClient: () => this.seenClient };
  }
}
const echo = toPlugin(EchoPlugin);

/** Declares a required env var, so resource validation has something to fail on. */
class NeedsEnvPlugin extends Plugin {
  static manifest = manifest("needsEnv", {
    resources: {
      required: [
        {
          type: "sql_warehouse",
          alias: "Harness Probe Warehouse",
          resourceKey: "harness-probe",
          description: "Exists only so validation has something to fail on",
          permission: "CAN_USE",
          fields: {
            id: {
              env: "MY_REQUIRED_SECRET",
              description: "Stand-in for a required resource field",
            },
          },
        },
      ],
      optional: [],
    },
  });
}
const needsEnv = toPlugin(NeedsEnvPlugin);

/** Fails during setup, to exercise the boot-failure teardown path. */
class BadSetupPlugin extends Plugin {
  static manifest = manifest("badSetup");
  async setup(): Promise<void> {
    throw new Error("setup went wrong");
  }
}
const badSetup = toPlugin(BadSetupPlugin);

describe("createTestApp", () => {
  test("boots with a single plugin and serves a real route", async () => {
    const app = await createTestApp({ plugins: [echo()] });
    try {
      expect(app.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(app.port).toBeGreaterThan(0);

      const res = await app.get("/api/echo/ping");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ pong: true });
    } finally {
      await app.close();
    }
  });

  test("two apps in one file get different ephemeral ports", async () => {
    const a = await createTestApp({ plugins: [echo()] });
    const b = await createTestApp({ plugins: [echo()] });
    try {
      // No EADDRINUSE, which is what makes the harness parallel-safe and is why
      // hardcoded test ports are worth removing.
      expect(a.port).not.toBe(b.port);
      await expect(a.get("/api/echo/ping").then((r) => r.status)).resolves.toBe(
        200,
      );
      await expect(b.get("/api/echo/ping").then((r) => r.status)).resolves.toBe(
        200,
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("boots with no credentials in the environment", async () => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DATABRICKS_")) delete process.env[key];
    }
    try {
      const app = await createTestApp({ plugins: [echo()] });
      try {
        await expect(
          app.get("/api/echo/ping").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await app.close();
      }
    } finally {
      process.env = saved;
    }
  });

  test("the default mock client reaches the plugin instead of crashing", async () => {
    const app = await createTestApp({ plugins: [echo()] });
    try {
      const res = await app.get("/api/echo/from-client");
      expect(res.status).toBe(200);
      // Undeclared path, so it resolves undefined rather than throwing — the
      // never-crash floor, exercised through a real handler.
      await expect(res.json()).resolves.toEqual({});
    } finally {
      await app.close();
    }
  });

  test("caller-supplied responses reach the plugin's client calls", async () => {
    const app = await createTestApp({
      plugins: [echo()],
      responses: { "jobs.getRun": { state: "TERMINATED" } },
    });
    try {
      const res = await app.get("/api/echo/from-client");
      await expect(res.json()).resolves.toEqual({
        run: { state: "TERMINATED" },
      });
      expect(getMockFn(app.client, "jobs.getRun")).toHaveBeenCalledWith({
        run_id: 1,
      });
    } finally {
      await app.close();
    }
  });

  test("app.client is the same object a handler resolves", async () => {
    const app = await createTestApp({ plugins: [echo()] });
    try {
      await app.get("/api/echo/client-identity");
      // Retires the "tribal seam knowledge" problem: no need to know that
      // createApp({ client }) flows through ServiceContext to reach a handler.
      expect(app.plugins.echo.seenClient()).toBe(app.client);
    } finally {
      await app.close();
    }
  });

  test("apiClient.request has zero calls after boot", async () => {
    const app = await createTestApp({ plugins: [echo()] });
    try {
      // A canary for two hazards at once: DATABRICKS_WORKSPACE_ID must
      // short-circuit the SCIM probe in getWorkspaceId, and internal telemetry
      // must stay off. If either regresses, request assertions get polluted and
      // this fails loudly.
      expect(getMockFn(app.client, "apiClient.request")).toHaveBeenCalledTimes(
        0,
      );
    } finally {
      await app.close();
    }
  });

  test("a caller-supplied server plugin is respected, and dedupes the injected one", async () => {
    const { server: serverPlugin } = await import("../../plugins/server");
    const app = await createTestApp({
      plugins: [echo(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    try {
      expect(app.port).toBeGreaterThan(0);
      await expect(
        app.get("/api/echo/ping").then((r) => r.status),
      ).resolves.toBe(200);
    } finally {
      await app.close();
    }
  });

  test("server: false together with a server plugin is refused", async () => {
    const { server: serverPlugin } = await import("../../plugins/server");
    await expect(
      createTestApp({
        plugins: [echo(), serverPlugin({ port: 0, host: "127.0.0.1" })],
        server: false,
      }),
    ).rejects.toThrow(/conflicts with the server plugin/);
  });

  test("server: false boots without a socket and request methods explain why", async () => {
    const app = await createTestApp({ plugins: [echo()], server: false });
    try {
      expect(app.server).toBeUndefined();
      expect(() => app.baseUrl).toThrow(/no HTTP server/);
      await expect(app.get("/api/echo/ping")).rejects.toThrow(/no HTTP server/);
    } finally {
      await app.close();
    }
  });

  test("await using releases at scope exit", async () => {
    let port: number | undefined;
    {
      await using app = await createTestApp({ plugins: [echo()] });
      port = app.port;
      await expect(
        app.get("/api/echo/ping").then((r) => r.status),
      ).resolves.toBe(200);
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  describe("resource validation (the strict posture)", () => {
    test("a missing required env var fails the boot", async () => {
      delete process.env.MY_REQUIRED_SECRET;
      await expect(createTestApp({ plugins: [needsEnv()] })).rejects.toThrow(
        /MY_REQUIRED_SECRET/,
      );
    });

    test("supplying it through env makes the same boot pass", async () => {
      const app = await createTestApp({
        plugins: [needsEnv(), echo()],
        env: { MY_REQUIRED_SECRET: "s3cret" },
      });
      try {
        await expect(
          app.get("/api/echo/ping").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await app.close();
      }
      // Restored, not leaked into the next test.
      expect(process.env.MY_REQUIRED_SECRET).toBeUndefined();
    });

    test("validation always throws, because the harness pins NODE_ENV", async () => {
      delete process.env.MY_REQUIRED_SECRET;

      // enforceValidation computes `shouldThrow = !isDevelopment || strict`, so
      // pinning NODE_ENV away from "development" is what makes the throw
      // unconditional. There is intentionally no option to soften this: the
      // warning path exists only in dev mode, which the harness refuses.
      await expect(
        createTestApp({ plugins: [needsEnv()], nodeEnv: "production" }),
      ).rejects.toThrow(/Missing required resources/);
      await expect(
        createTestApp({ plugins: [needsEnv()], nodeEnv: "test" }),
      ).rejects.toThrow(/Missing required resources/);
    });
  });

  describe("environment hygiene", () => {
    test("close() restores the snapshot, including pre-existing values", async () => {
      process.env.DATABRICKS_HOST = "https://original.example.com";
      const before = { ...process.env };

      const app = await createTestApp({
        plugins: [echo()],
        env: { HARNESS_ADDED: "yes" },
      });
      // The harness overwrote DATABRICKS_HOST with its test default.
      expect(process.env.DATABRICKS_HOST).not.toBe(
        "https://original.example.com",
      );
      await app.close();

      // A pre-existing value is restored to *its* value, not the test default,
      // and a key the harness added is deleted rather than left behind.
      expect(process.env.DATABRICKS_HOST).toBe("https://original.example.com");
      expect(process.env.HARNESS_ADDED).toBeUndefined();
      expect(Object.keys(process.env).sort()).toEqual(
        Object.keys(before).sort(),
      );

      delete process.env.DATABRICKS_HOST;
    });

    test("a boot failure still restores env and resets singletons", async () => {
      const before = { ...process.env };

      await expect(
        createTestApp({ plugins: [badSetup()], env: { LEAKED: "no" } }),
      ).rejects.toThrow(/setup went wrong/);

      // Teardown has to run from the setup-failure path, or every later test in
      // the file inherits the mutated env.
      expect(process.env.LEAKED).toBeUndefined();
      expect(Object.keys(process.env).sort()).toEqual(
        Object.keys(before).sort(),
      );

      // And the next boot still works.
      const app = await createTestApp({ plugins: [echo()] });
      await expect(
        app.get("/api/echo/ping").then((r) => r.status),
      ).resolves.toBe(200);
      await app.close();
    });

    test('nodeEnv: "development" is refused with an explanation', async () => {
      // The get-port RangeError must never reach the user.
      await expect(
        createTestApp({ plugins: [echo()], nodeEnv: "development" }),
      ).rejects.toThrow(/not supported/);
    });

    test("SIGTERM listener count is unchanged across boot and close", async () => {
      const baseline = process.listenerCount("SIGTERM");
      const app = await createTestApp({ plugins: [echo()] });
      await app.close();
      // Guards the MaxListenersExceededWarning that shows up at ~6 un-closed
      // boots in one file.
      expect(process.listenerCount("SIGTERM")).toBe(baseline);
    });

    test("boot, close, boot again in one file", async () => {
      const first = await createTestApp({ plugins: [echo()] });
      const firstPort = first.port;
      await first.close();

      const second = await createTestApp({ plugins: [echo()] });
      try {
        expect(second.port).not.toBe(firstPort);
        await expect(
          second.get("/api/echo/ping").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await second.close();
      }
    });

    test("overlapping boots restore env regardless of close order", async () => {
      const before = { ...process.env };

      // The second boot's view of "original" already contains the first boot's
      // mutations. A per-app snapshot would let whichever closes last re-apply
      // them, stranding harness keys and `A_ONLY` after both apps are gone.
      const a = await createTestApp({
        plugins: [echo()],
        env: { OVERLAP_A: "a" },
      });
      const b = await createTestApp({
        plugins: [echo()],
        env: { OVERLAP_B: "b" },
      });

      await a.close();
      await b.close();

      const leaked = Object.keys(process.env).filter((k) => !(k in before));
      expect(leaked).toEqual([]);
      expect(process.env.OVERLAP_A).toBeUndefined();
      expect(process.env.OVERLAP_B).toBeUndefined();
      expect(Object.keys(process.env).sort()).toEqual(
        Object.keys(before).sort(),
      );
    });

    test("closing in reverse order also restores env", async () => {
      const before = { ...process.env };
      const a = await createTestApp({ plugins: [echo()], env: { REV_A: "a" } });
      const b = await createTestApp({ plugins: [echo()], env: { REV_B: "b" } });

      // Reverse of boot order — the outcome must not depend on it.
      await b.close();
      await a.close();

      expect(Object.keys(process.env).filter((k) => !(k in before))).toEqual(
        [],
      );
    });

    test("close() is idempotent", async () => {
      const app = await createTestApp({ plugins: [echo()] });
      await app.close();
      await expect(app.close()).resolves.toBeUndefined();
    });
  });
});
