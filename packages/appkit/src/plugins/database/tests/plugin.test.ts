import type express from "express";
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { defineSchema, fk, id, text } from "../../../database/schema-builder";

const mocks = vi.hoisted(() => ({ createDatabaseState: vi.fn() }));
vi.mock("../lifecycle", () => ({
  createDatabaseState: mocks.createDatabaseState,
}));

import { DatabasePlugin, database } from "../database";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const schema = defineSchema(() => ({}));
const routedSchema = defineSchema((builder) => {
  const users = builder.table("users", { id: id(), name: text() });
  const notes = builder.table("notes", {
    id: id(),
    authorId: fk(() => users.id),
  });
  const events = builder.table("events", { message: text() });
  return { users, notes, events };
});

function fakeRouter() {
  const routes: string[] = [];
  const record =
    (method: string) =>
    (path: string): void => {
      routes.push(`${method} ${path}`);
    };
  return {
    routes,
    router: {
      get: record("get"),
      post: record("post"),
      patch: record("patch"),
      delete: record("delete"),
      put: record("put"),
    } as unknown as express.Router,
  };
}

async function registerRoutes(
  config: ConstructorParameters<typeof DatabasePlugin<typeof routedSchema>>[0],
) {
  mocks.createDatabaseState.mockResolvedValue(candidate());
  const plugin = new DatabasePlugin(config);
  await plugin.setup();
  const { router, routes } = fakeRouter();
  plugin.injectRoutes(router);
  return { plugin, routes };
}

function candidate(marker = "one") {
  let active = true;
  const end = vi.fn<() => Promise<void>>(async () => undefined);
  return {
    pool: { end },
    exports: {
      marker,
      operation: () => {
        if (!active) throw new Error("inactive");
      },
    },
    deactivate: vi.fn(() => {
      active = false;
    }),
  };
}

describe("DatabasePlugin", () => {
  beforeEach(() => mocks.createDatabaseState.mockReset());

  test("retains schema and declares the fixed beta postgres manifest", () => {
    const definition = database({ schema });
    expectTypeOf(definition.config.schema).toEqualTypeOf<typeof schema>();
    const assertConfigTypes = () => {
      // @ts-expect-error execution policy is internal and cannot be configured
      database({ schema, retry: { enabled: true, attempts: 3 } });
    };
    void assertConfigTypes;
    expect(definition).toMatchObject({ name: "database", config: { schema } });
    expect(DatabasePlugin.manifest).toMatchObject({
      name: "database",
      stability: "beta",
    });
    expect(DatabasePlugin.manifest.resources.required).toContainEqual(
      expect.objectContaining({ resourceKey: "postgres", type: "postgres" }),
    );
    const plugin = new DatabasePlugin({
      schema,
      retry: { enabled: true, attempts: 3 },
    } as unknown as { schema: typeof schema });
    expect(
      (plugin as unknown as { config: Record<string, unknown> }).config,
    ).toEqual({ schema });
  });

  test("publishes only after readiness and setup is single-flight", async () => {
    const construction = deferred<ReturnType<typeof candidate>>();
    mocks.createDatabaseState.mockReturnValue(construction.promise);
    const plugin = new DatabasePlugin({ schema });
    const first = plugin.setup();
    const second = plugin.setup();
    expect(() => plugin.exports()).toThrow();
    expect(mocks.createDatabaseState).toHaveBeenCalledTimes(1);
    const state = candidate();
    construction.resolve(state);
    await Promise.all([first, second]);
    expect(plugin.exports()).toEqual(state.exports);
  });

  test("hands out a fresh export surface per access", async () => {
    const state = candidate();
    mocks.createDatabaseState.mockResolvedValue(state);
    const plugin = new DatabasePlugin({ schema });
    await plugin.setup();
    expect(plugin.exports()).not.toBe(plugin.exports());
    expect(plugin.exports()).not.toBe(state.exports);
    expect(plugin.exports()).toEqual(state.exports);
  });

  test("shutdown racing setup waits, prevents publication, deactivates, and closes", async () => {
    const construction = deferred<ReturnType<typeof candidate>>();
    mocks.createDatabaseState.mockReturnValue(construction.promise);
    const plugin = new DatabasePlugin({ schema });
    const setup = plugin.setup();
    const shutdown = plugin.shutdown();
    const state = candidate();
    construction.resolve(state);
    await expect(setup).rejects.toMatchObject({ category: "SETUP_FAILED" });
    await shutdown;
    expect(state.deactivate).toHaveBeenCalledTimes(1);
    expect(state.pool.end).toHaveBeenCalledTimes(1);
    expect(() => plugin.exports()).toThrow();
  });

  test("deactivates and unpublishes before one shared close", async () => {
    const close = deferred<void>();
    const state = candidate();
    state.pool.end.mockReturnValue(close.promise);
    mocks.createDatabaseState.mockResolvedValue(state);
    const plugin = new DatabasePlugin({ schema });
    await plugin.setup();
    const first = plugin.shutdown();
    const second = plugin.shutdown();
    await vi.waitFor(() => expect(state.deactivate).toHaveBeenCalledTimes(1));
    expect(state.deactivate).toHaveBeenCalledTimes(1);
    expect(() => plugin.exports()).toThrow();
    expect(state.pool.end).toHaveBeenCalledTimes(1);
    close.resolve();
    await Promise.all([first, second]);
    await plugin.shutdown();
    expect(state.pool.end).toHaveBeenCalledTimes(1);
  });

  test("sanitizes close failure and repeats the same safe rejection", async () => {
    const state = candidate();
    state.pool.end.mockRejectedValue(new Error("socket password secret"));
    mocks.createDatabaseState.mockResolvedValue(state);
    const plugin = new DatabasePlugin({ schema });
    await plugin.setup();
    const first = plugin.shutdown();
    const error = await first.catch((caught) => caught);
    expect(error).toMatchObject({
      category: "INTERNAL",
      phase: "shutdown",
      cause: undefined,
    });
    expect(error.message).toBe("Database operation failed");
    await expect(plugin.shutdown()).rejects.toBe(error);
  });

  test.each([undefined, true, {}, { writes: true }, { writes: {} }] as const)(
    "registers full CRUD by default with api=%j",
    async (api) => {
      const { routes, plugin } = await registerRoutes({
        schema: routedSchema,
        api,
      });
      expect(routes).toEqual([
        "get /users",
        "post /users",
        "get /users/:id",
        "patch /users/:id",
        "delete /users/:id",
        "get /notes",
        "post /notes",
        "get /notes/:id",
        "patch /notes/:id",
        "delete /notes/:id",
        // A keyless table supports list/create, but no keyed operations.
        "get /events",
        "post /events",
      ]);
      expect(plugin.getEndpoints()).toMatchObject({
        "users.create": "/api/database/users",
        "users.update": "/api/database/users/:id",
        "users.delete": "/api/database/users/:id",
      });
      // Upsert stays programmatic, and no PUT route is generated.
      expect(routes.some((route) => route.startsWith("put "))).toBe(false);
      expect(plugin.getEndpoints()).not.toHaveProperty("users.upsert");
    },
  );

  test.each([false, { tables: [] }] as const)(
    "disables generated routes with api=%j without disabling the typed API",
    async (api) => {
      const { routes, plugin } = await registerRoutes({
        schema: routedSchema,
        api,
      });
      expect(routes).toEqual([]);
      expect(plugin.exports()).toHaveProperty("operation");
    },
  );

  test("restricts CRUD to a selected table without a separate write opt-in", async () => {
    const assertNames = () => {
      database({
        schema: routedSchema,
        api: {
          tables: ["notes"],
          writes: { operations: ["create", "update"] },
        },
      });
      database({
        schema: routedSchema,
        hooks: { notes: { serialize: (row) => row } },
      });
      database({
        schema: routedSchema,
        // @ts-expect-error only a declared table can be exposed
        api: { tables: ["missing"] },
      });
      database({
        schema: routedSchema,
        // @ts-expect-error only a declared table can shape its own responses
        hooks: { missing: { serialize: (row) => row } },
      });
    };
    const assertApiTypes = () => {
      database({
        schema: routedSchema,
        // @ts-expect-error generated writes do not expose upsert
        api: { writes: { operations: ["upsert"] } },
      });
      database({
        schema: routedSchema,
        // @ts-expect-error write restrictions must name declared tables
        api: { writes: { tables: ["missing"] } },
      });
      database({
        schema: routedSchema,
        // @ts-expect-error the generated API option is named api
        crudRoutes: false,
      });
    };
    void assertNames;
    void assertApiTypes;

    const subset = await registerRoutes({
      schema: routedSchema,
      api: { tables: ["notes"] },
    });
    expect(subset.routes).toEqual([
      "get /notes",
      "post /notes",
      "get /notes/:id",
      "patch /notes/:id",
      "delete /notes/:id",
    ]);
  });

  test.each([false, { tables: [] }, { operations: [] }] as const)(
    "keeps reads when writes=%j",
    async (writes) => {
      const { routes } = await registerRoutes({
        schema: routedSchema,
        api: { writes },
      });
      expect(routes).toEqual([
        "get /users",
        "get /users/:id",
        "get /notes",
        "get /notes/:id",
        "get /events",
      ]);
    },
  );

  test("defaults to all write operations when restricting writable tables", async () => {
    const { routes } = await registerRoutes({
      schema: routedSchema,
      api: { writes: { tables: ["notes"] } },
    });
    expect(routes).toEqual([
      "get /users",
      "get /users/:id",
      "get /notes",
      "post /notes",
      "get /notes/:id",
      "patch /notes/:id",
      "delete /notes/:id",
      "get /events",
    ]);
  });

  test("can disable delete without restricting tables", async () => {
    const { routes } = await registerRoutes({
      schema: routedSchema,
      api: { writes: { operations: ["create", "update"] } },
    });
    expect(routes).toEqual([
      "get /users",
      "post /users",
      "get /users/:id",
      "patch /users/:id",
      "get /notes",
      "post /notes",
      "get /notes/:id",
      "patch /notes/:id",
      "get /events",
      "post /events",
    ]);
  });

  test("restricts writable tables and operations together", async () => {
    const constrained = await registerRoutes({
      schema: routedSchema,
      api: {
        tables: ["users", "notes"],
        writes: { tables: ["notes"], operations: ["create", "update"] },
      },
    });
    expect(constrained.routes).toEqual([
      "get /users",
      "get /users/:id",
      "get /notes",
      "post /notes",
      "get /notes/:id",
      "patch /notes/:id",
    ]);
  });

  test("fails setup on an exposure list it cannot honor", async () => {
    for (const tables of [["missing"], ["users", "users"], "users"]) {
      mocks.createDatabaseState.mockResolvedValue(candidate());
      const plugin = new DatabasePlugin({
        schema: routedSchema,
        api: { tables } as unknown as { tables: ["users"] },
      });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
      });
    }
  });

  test("rejects invalid or misspelled route restrictions rather than enabling CRUD", async () => {
    for (const api of [null, [], "false", { write: false }, new Date()]) {
      const plugin = new DatabasePlugin({
        schema: routedSchema,
        api: api as never,
      });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
      });
    }
    expect(mocks.createDatabaseState).not.toHaveBeenCalled();
  });

  test("fails setup on write exposure it cannot honor", async () => {
    const invalid = [
      { writes: null },
      { writes: [] },
      { writes: "false" },
      { writes: { operation: ["create"] } },
      {
        tables: ["notes"],
        writes: { tables: ["users"], operations: ["create"] },
      },
      {
        tables: ["notes"],
        writes: { operations: ["create", "create"] },
      },
      {
        tables: ["notes"],
        writes: { operations: ["upsert"] },
      },
    ];
    for (const api of invalid) {
      const plugin = new DatabasePlugin({
        schema: routedSchema,
        api: api as never,
      });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
      });
    }
  });

  test("fails setup on a hook key that names no declared table", async () => {
    mocks.createDatabaseState.mockResolvedValue(candidate());
    const plugin = new DatabasePlugin({
      schema: routedSchema,
      hooks: { missing: { beforeCreate: () => undefined } } as never,
    });
    await expect(plugin.setup()).rejects.toMatchObject({
      category: "SETUP_FAILED",
    });
  });

  test.each([undefined, true] as const)(
    "refuses ambiguous route names with api=%j",
    async (api) => {
      const unsafe = [
        defineSchema((builder) => ({
          users: builder.table("users", { id: id() }),
          Users: builder.table("Users", { id: id() }),
        })),
        defineSchema((builder) => ({
          _hidden: builder.table("_hidden", { id: id() }),
        })),
      ];
      for (const unsafeSchema of unsafe) {
        mocks.createDatabaseState.mockResolvedValue(candidate());
        const plugin = new DatabasePlugin({
          schema: unsafeSchema,
          api,
        });
        await expect(plugin.setup()).rejects.toMatchObject({
          category: "SETUP_FAILED",
          message: expect.stringContaining("api.tables"),
          clientMessage: "Database setup failed",
        });
      }
      expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    },
  );

  test("supports non-routable table names when generated routes are disabled", async () => {
    const internalSchema = defineSchema((builder) => ({
      _events: builder.table("_events", { id: id() }),
    }));
    mocks.createDatabaseState.mockResolvedValue(candidate());
    const plugin = new DatabasePlugin({
      schema: internalSchema,
      api: false,
    });
    await plugin.setup();
    const { router, routes } = fakeRouter();
    plugin.injectRoutes(router);
    expect(routes).toEqual([]);
  });

  test.each([false, true, { writes: false }, { tables: ["notes"] }])(
    "rejects the removed crudRoutes option instead of silently enabling the API: %j",
    (crudRoutes) => {
      for (const api of [undefined, false, true]) {
        expect(
          () =>
            new DatabasePlugin({
              schema: routedSchema,
              api,
              crudRoutes,
            } as never),
        ).toThrow('"crudRoutes" was renamed to "api"');
      }
      expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    },
  );

  test("can keep an internal table in the schema without generating its routes", async () => {
    const internalSchema = defineSchema((builder) => ({
      notes: builder.table("notes", { id: id() }),
      _events: builder.table("_events", { id: id() }),
    }));
    mocks.createDatabaseState.mockResolvedValue(candidate());
    const plugin = new DatabasePlugin({
      schema: internalSchema,
      api: { tables: ["notes"] },
    });
    await plugin.setup();
    const { router, routes } = fakeRouter();
    plugin.injectRoutes(router);
    expect(routes).toEqual([
      "get /notes",
      "post /notes",
      "get /notes/:id",
      "patch /notes/:id",
      "delete /notes/:id",
    ]);
    expect(mocks.createDatabaseState).toHaveBeenCalledWith(
      internalSchema,
      expect.any(Function),
      undefined,
    );
  });

  test("isolates plugin instances and drains their exports independently", async () => {
    const one = candidate("one");
    const two = candidate("two");
    mocks.createDatabaseState
      .mockResolvedValueOnce(one)
      .mockResolvedValueOnce(two);
    const first = new DatabasePlugin({ schema });
    const second = new DatabasePlugin({ schema });
    await Promise.all([first.setup(), second.setup()]);
    expect(first.exports()).toEqual(one.exports);
    expect(second.exports()).toEqual(two.exports);
    await first.shutdown();
    expect(() => one.exports.operation()).toThrow("inactive");
    expect(() => first.exports()).toThrow();
    expect(second.exports()).toEqual(two.exports);
  });
});
