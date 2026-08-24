import type {
  IAppRequest,
  IAppResponse,
  IAppRouter,
  PluginConstructor,
  PluginData,
  PluginManifest,
} from "shared";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getWorkspaceClient } from "../../context";
import { getUserContext } from "../../context/execution-context";
import { Plugin, toPlugin } from "../../plugin";
import type { WorkspaceClient } from "../../workspace-client";
import type { CreateTestAppOptions, TestApp } from "../create-test-app";
import { createTestApp } from "../create-test-app";
import { expectStream } from "../expect-stream";
import { createMockWorkspaceClient, getMock } from "../mock-workspace-client";

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

/**
 * One probe for both halves of the harness: boot/data-plane concerns and the
 * HTTP layer. Routes go through `this.route()`, the way real plugins register
 * them — that is what wraps handlers in forwardAsyncErrors, so a rejection
 * reaches errorHandlerMiddleware instead of hanging the request.
 */
class ProbePlugin extends Plugin {
  static manifest = manifest("probe");

  /** The client this plugin resolved at request time. */
  seenClient: WorkspaceClient | undefined;

  injectRoutes(router: IAppRouter): void {
    const r = (
      method: "get" | "post" | "put" | "patch" | "delete",
      path: string,
      handler: (req: IAppRequest, res: IAppResponse) => Promise<void>,
    ) =>
      this.route(router, { name: `${method}${path}`, method, path, handler });

    r("get", "/ping", async (_req, res) => {
      res.json({ pong: true });
    });

    // A non-default status, to prove the handler's status propagates.
    r("get", "/created", async (_req, res) => {
      res.status(201).json({ ok: true, method: "GET" });
    });

    r("get", "/from-client", async (_req, res) => {
      this.seenClient = getWorkspaceClient();
      res.json({
        run: await this.seenClient.jobs.getRun({ run_id: 1 } as never),
      });
    });

    r("post", "/echo", async (req, res) => {
      res.json({
        body: req.body,
        contentType: req.headers["content-type"] ?? null,
      });
    });

    r("get", "/headers", async (req, res) => {
      res.json({
        custom: req.headers["x-custom"] ?? null,
        user: req.headers["x-forwarded-user"] ?? null,
        token: req.headers["x-forwarded-access-token"] ?? null,
        email: req.headers["x-forwarded-email"] ?? null,
      });
    });

    // The real asUser path, so the forwarded identity has to be genuine.
    r("get", "/as-user", async (req, res) => {
      const ex = this.asUser(req).exports() as {
        whoami: () => { userId?: string };
      };
      res.json(ex.whoami());
    });

    // Calls the client *inside* asUser, unlike /as-user which only reads userId.
    r("get", "/as-user-client", async (req, res) => {
      const ex = this.asUser(req).exports() as {
        probeClient: () => Promise<unknown>;
      };
      res.json({ run: (await ex.probeClient()) ?? null });
    });

    r("get", "/boom", async () => {
      throw new Error("handler exploded");
    });

    r("post", "/stream", async (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: status\ndata: ${JSON.stringify({ s: "start" })}\n\n`);
      res.write(`event: result\ndata: ${JSON.stringify({ rows: [1] })}\n\n`);
      res.end();
    });

    for (const method of ["put", "patch"] as const) {
      r(method, "/verb", async (req, res) => {
        res.json({ m: method.toUpperCase(), b: req.body });
      });
    }
    r("delete", "/verb", async (_req, res) => {
      res.json({ m: "DELETE" });
    });
  }

  exports() {
    return {
      seenClient: () => this.seenClient,
      whoami: () => ({ userId: getUserContext()?.userId }),
      // Calls through the client so the harness's mock records it — a real
      // OBO client would record nothing here.
      probeClient: () =>
        getWorkspaceClient().jobs.getRun({ run_id: 42 } as never),
    };
  }
}
const probe = toPlugin(ProbePlugin);

/** Boot, run the body, always close. Collapses the try/finally every test needs. */
async function withApp<
  P extends PluginData<PluginConstructor, unknown, string>[],
>(
  options: CreateTestAppOptions<P>,
  body: (app: TestApp<P>) => Promise<void>,
): Promise<void> {
  const app = await createTestApp(options);
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

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

/**
 * Boots cleanly, then throws when the harness asks for the socket — the only way
 * to reach the failure path *after* `createApp` has already returned an app.
 * Named `server` so the harness uses it instead of adding the real one.
 */
class LateFailurePlugin extends Plugin {
  static manifest = manifest("server");
  exports() {
    return {
      getServer: () => {
        throw new Error("getServer exploded");
      },
    };
  }
}
const lateFailure = toPlugin(LateFailurePlugin);

describe("createTestApp", () => {
  test("boots with a single plugin and serves a real route", async () => {
    await withApp({ plugins: [probe()] }, async (app) => {
      expect(app.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(app.port).toBeGreaterThan(0);

      const res = await app.get("/api/probe/ping");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ pong: true });
    });
  });

  test("two apps in one file get different ephemeral ports", async () => {
    const a = await createTestApp({ plugins: [probe()] });
    const b = await createTestApp({ plugins: [probe()] });
    try {
      // No EADDRINUSE, which is what makes the harness parallel-safe and is why
      // hardcoded test ports are worth removing.
      expect(a.port).not.toBe(b.port);
      await expect(
        a.get("/api/probe/ping").then((r) => r.status),
      ).resolves.toBe(200);
      await expect(
        b.get("/api/probe/ping").then((r) => r.status),
      ).resolves.toBe(200);
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
      await withApp({ plugins: [probe()] }, async (app) => {
        await expect(
          app.get("/api/probe/ping").then((r) => r.status),
        ).resolves.toBe(200);
      });
    } finally {
      process.env = saved;
    }
  });

  test("the default mock client reaches the plugin instead of crashing", async () => {
    await withApp({ plugins: [probe()] }, async (app) => {
      const res = await app.get("/api/probe/from-client");
      expect(res.status).toBe(200);
      // Undeclared path, so it resolves undefined rather than throwing — the
      // never-crash floor, exercised through a real handler.
      await expect(res.json()).resolves.toEqual({});
    });
  });

  test("caller-supplied responses reach the plugin's client calls", async () => {
    await withApp(
      {
        plugins: [probe()],
        responses: { "jobs.getRun": { state: "TERMINATED" } },
      },
      async (app) => {
        const res = await app.get("/api/probe/from-client");
        await expect(res.json()).resolves.toEqual({
          run: { state: "TERMINATED" },
        });
        expect(getMock(app.client, "jobs.getRun")).toHaveBeenCalledWith({
          run_id: 1,
        });
      },
    );
  });

  test("app.client is the same object a handler resolves", async () => {
    await withApp({ plugins: [probe()] }, async (app) => {
      await app.get("/api/probe/from-client");
      // Retires the "tribal seam knowledge" problem: no need to know that
      // createApp({ client }) flows through ServiceContext to reach a handler.
      expect(app.plugins.probe.seenClient()).toBe(app.client);
    });
  });

  test("apiClient.request has zero calls after boot", async () => {
    await withApp({ plugins: [probe()] }, async (app) => {
      // A canary for two hazards at once: DATABRICKS_WORKSPACE_ID must
      // short-circuit the SCIM probe in getWorkspaceId, and internal telemetry
      // must stay off. If either regresses, request assertions get polluted and
      // this fails loudly.
      expect(getMock(app.client, "apiClient.request")).toHaveBeenCalledTimes(0);
    });
  });

  test("a caller-supplied server plugin is respected, and dedupes the injected one", async () => {
    const { server: serverPlugin } = await import("../../plugins/server");
    await withApp(
      {
        plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
      },
      async (app) => {
        expect(app.port).toBeGreaterThan(0);
        await expect(
          app.get("/api/probe/ping").then((r) => r.status),
        ).resolves.toBe(200);
      },
    );
  });

  test("server: false together with a server plugin is refused", async () => {
    const { server: serverPlugin } = await import("../../plugins/server");
    await expect(
      createTestApp({
        plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
        server: false,
      }),
    ).rejects.toThrow(/conflicts with the server plugin/);
  });

  test("server: false boots without a socket and request methods explain why", async () => {
    await withApp({ plugins: [probe()], server: false }, async (app) => {
      expect(app.server).toBeUndefined();
      expect(() => app.baseUrl).toThrow(/no HTTP server/);
      await expect(app.get("/api/probe/ping")).rejects.toThrow(
        /no HTTP server/,
      );
    });
  });

  test("await using releases at scope exit", async () => {
    let port: number | undefined;
    {
      await using app = await createTestApp({ plugins: [probe()] });
      port = app.port;
      await expect(
        app.get("/api/probe/ping").then((r) => r.status),
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
      await withApp(
        {
          plugins: [needsEnv(), probe()],
          env: { MY_REQUIRED_SECRET: "s3cret" },
        },
        async (app) => {
          await expect(
            app.get("/api/probe/ping").then((r) => r.status),
          ).resolves.toBe(200);
        },
      );
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
        plugins: [probe()],
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
      const app = await createTestApp({ plugins: [probe()] });
      await expect(
        app.get("/api/probe/ping").then((r) => r.status),
      ).resolves.toBe(200);
      await app.close();
    });

    test("a failure after createApp still tears the built app down", async () => {
      // The other boot-failure test throws inside createApp, so `app` is never
      // assigned and only the "nothing was built" branch runs. This one gets a
      // live app first, exercising the branch that has to close it.
      const before = { ...process.env };

      await expect(
        createTestApp({ plugins: [lateFailure()], env: { LEAKED: "no" } }),
      ).rejects.toThrow(/getServer exploded/);

      expect(process.env.LEAKED).toBeUndefined();
      expect(Object.keys(process.env).sort()).toEqual(
        Object.keys(before).sort(),
      );

      // The singleton claim has to be released too, or this boot reuses the
      // failed app's half-closed singletons.
      const app = await createTestApp({ plugins: [probe()] });
      try {
        await expect(
          app.get("/api/probe/ping").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await app.close();
      }
    });

    test("passing both client and responses is refused, not silently ignored", async () => {
      // `responses` only seeds the built-in mock, so with a supplied client it
      // used to do nothing at all — the caller's seeded values never took effect
      // and nothing said so.
      await expect(
        createTestApp({
          plugins: [probe()],
          client: createMockWorkspaceClient(),
          responses: { "jobs.getRun": { state: "IGNORED" } },
        }),
      ).rejects.toThrow(/does nothing when you also pass `client`/);
    });

    test('nodeEnv: "development" is refused with an explanation', async () => {
      // The get-port RangeError must never reach the user.
      await expect(
        createTestApp({ plugins: [probe()], nodeEnv: "development" }),
      ).rejects.toThrow(/not supported/);
    });

    test("SIGTERM listener count is unchanged across boot and close", async () => {
      const baseline = process.listenerCount("SIGTERM");
      const app = await createTestApp({ plugins: [probe()] });
      await app.close();
      // Guards the MaxListenersExceededWarning that shows up at ~6 un-closed
      // boots in one file.
      expect(process.listenerCount("SIGTERM")).toBe(baseline);
    });

    test("boot, close, boot again in one file", async () => {
      const first = await createTestApp({ plugins: [probe()] });
      const firstPort = first.port;
      await first.close();

      const second = await createTestApp({ plugins: [probe()] });
      try {
        expect(second.port).not.toBe(firstPort);
        await expect(
          second.get("/api/probe/ping").then((r) => r.status),
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
        plugins: [probe()],
        env: { OVERLAP_A: "a" },
      });
      const b = await createTestApp({
        plugins: [probe()],
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
      const a = await createTestApp({
        plugins: [probe()],
        env: { REV_A: "a" },
      });
      const b = await createTestApp({
        plugins: [probe()],
        env: { REV_B: "b" },
      });

      // Reverse of boot order — the outcome must not depend on it.
      await b.close();
      await a.close();

      expect(Object.keys(process.env).filter((k) => !(k in before))).toEqual(
        [],
      );
    });

    test("close() is idempotent", async () => {
      const app = await createTestApp({ plugins: [probe()] });
      await app.close();
      await expect(app.close()).resolves.toBeUndefined();
    });
  });
});

describe("createTestApp HTTP layer", () => {
  let app: TestApp<[ReturnType<typeof probe>]>;

  beforeAll(async () => {
    app = await createTestApp({ plugins: [probe()] });
  });

  afterAll(async () => {
    await app?.close();
  });

  test("GET returns the plugin's JSON body and status", async () => {
    const res = await app.get("/api/probe/created");
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, method: "GET" });
  });

  test("POST with an object body arrives JSON-parsed at the handler", async () => {
    const res = await app.post("/api/probe/echo", {
      body: { q: 1, nested: [2] },
    });

    // Proves the real express.json() middleware ran, not a shortcut.
    await expect(res.json()).resolves.toEqual({
      body: { q: 1, nested: [2] },
      contentType: "application/json",
    });
  });

  test("POST with a string body and explicit content-type passes through unmodified", async () => {
    const res = await app.post("/api/probe/echo", {
      body: "raw text, not JSON",
      headers: { "content-type": "text/plain" },
    });

    // express.json() ignores a non-JSON content-type, so the handler sees an
    // empty body — the point is that the harness did not re-encode or override.
    await expect(res.json()).resolves.toMatchObject({
      contentType: "text/plain",
    });
  });

  // All three hit /headers and differ only in what `obo`/`headers` should produce.
  test.each([
    [
      "obo: true sets the forwarded identity",
      { obo: true as const },
      { user: "test-user", token: "test-user-token" },
    ],
    [
      "obo object overrides the identity",
      { obo: { userId: "alice", email: "alice@example.com" } },
      { user: "alice", email: "alice@example.com" },
    ],
    [
      "explicit headers win over what obo generated",
      {
        obo: true as const,
        headers: { "x-custom": "hello", "x-forwarded-user": "override" },
      },
      { custom: "hello", user: "override", token: "test-user-token" },
    ],
    [
      "a mixed-case override wins too, rather than comma-joining",
      { obo: true as const, headers: { "X-Forwarded-User": "override" } },
      { user: "override", token: "test-user-token" },
    ],
  ])("%s", async (_name, options, expected) => {
    const res = await app.get("/api/probe/headers", options);
    await expect(res.json()).resolves.toMatchObject(expected);
  });

  test("a handler using asUser resolves the forwarded test user", async () => {
    const res = await app.get("/api/probe/as-user", { obo: { userId: "bob" } });
    // The real user-context path, driven entirely by the `obo` flag.
    await expect(res.json()).resolves.toEqual({ userId: "bob" });
  });

  test("an SSE route composes with expectStream directly", async () => {
    // The dogfooding report's #1 friction, avoided by construction: the request
    // methods return a native Response, which expectStream already accepts.
    const res = await app.post("/api/probe/stream");
    await expectStream(res).toEmit("status", "result");
  });

  test("a throwing handler produces the real error-middleware response", async () => {
    const res = await app.get("/api/probe/boom");

    // Handled by the real errorHandlerMiddleware rather than escaping as an
    // unhandled rejection that would hang the request and fail the run.
    expect(res.status).toBe(500);

    // The message is included because errorHandlerMiddleware redacts only when
    // NODE_ENV === "production", and the harness pins "test". That is the
    // useful behaviour for a test — an assertion can name the failure — but it
    // does mean this response shape is the dev one, not what a deployed app
    // returns to a client.
    await expect(res.json()).resolves.toEqual({ error: "handler exploded" });
  });

  test("an unmounted path is a 404", async () => {
    const res = await app.get("/api/probe/nope");
    expect(res.status).toBe(404);
  });

  test("put, patch, and delete reach their handlers", async () => {
    await expect(
      app.put("/api/probe/verb", { body: { a: 1 } }).then((r) => r.json()),
    ).resolves.toEqual({ m: "PUT", b: { a: 1 } });
    await expect(
      app.patch("/api/probe/verb", { body: { a: 2 } }).then((r) => r.json()),
    ).resolves.toEqual({ m: "PATCH", b: { a: 2 } });
    await expect(
      app.delete("/api/probe/verb").then((r) => r.json()),
    ).resolves.toEqual({ m: "DELETE" });
  });

  test("a signal aborts an in-flight request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      app.get("/api/probe/json", { signal: controller.signal }),
    ).rejects.toThrow();
  });
  test("an obo request gets the mock client, not a real one", async () => {
    await withApp(
      { plugins: [probe()], responses: { "jobs.getRun": { via: "mock" } } },
      async (app) => {
        const res = await app.get("/api/probe/as-user-client", {
          obo: { userId: "carol" },
        });
        expect(res.status).toBe(200);

        // Asserting the host would not discriminate — a real client built from
        // DATABRICKS_HOST carries the same string. What only the mock can do is
        // record the call and return the declared response.
        await expect(res.json()).resolves.toEqual({ run: { via: "mock" } });
        expect(getMock(app.client, "jobs.getRun")).toHaveBeenCalledWith({
          run_id: 42,
        });
      },
    );
  });

  describe("overlapping apps", () => {
    test("booting a second app does not rebind the first's singletons", async () => {
      const a = await createTestApp({ plugins: [probe()] });
      const b = await createTestApp({ plugins: [probe()] });
      try {
        // Both must still resolve their own client through the real seam. Before
        // the singletons were refcounted, B's boot reset and rebound A's.
        await expect(
          a.get("/api/probe/from-client").then((r) => r.status),
        ).resolves.toBe(200);
        await expect(
          b.get("/api/probe/from-client").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("closing one app leaves the other's context intact", async () => {
      const a = await createTestApp({ plugins: [probe()] });
      const b = await createTestApp({ plugins: [probe()] });
      try {
        await a.close();
        // Previously A's close dropped the singletons, so this threw
        // InitializationError from ServiceContext.get().
        await expect(
          b.get("/api/probe/from-client").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await b.close();
      }
    });

    test("a stale handle's second close cannot reset a newer app", async () => {
      const first = await createTestApp({ plugins: [probe()] });
      await first.close();

      const second = await createTestApp({ plugins: [probe()] });
      try {
        // close() is memoized, so this is a no-op rather than a second release.
        await first.close();
        await expect(
          second.get("/api/probe/from-client").then((r) => r.status),
        ).resolves.toBe(200);
      } finally {
        await second.close();
      }
    });
  });
});
