import type express from "express";
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { defineSchema, fk, id, text } from "../../../database/schema-builder";

const mocks = vi.hoisted(() => ({
  createDatabaseState: vi.fn(),
  loadDefaultDatabaseSchema: vi.fn(),
}));
vi.mock("../lifecycle", () => ({
  createDatabaseState: mocks.createDatabaseState,
}));
vi.mock("../load-schema", () => ({
  loadDefaultDatabaseSchema: mocks.loadDefaultDatabaseSchema,
}));

import { DatabasePlugin, database } from "../database";
import { defineOperation } from "../operations";

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

// The package has no generated registry, so this takes the untyped JS path.
const define = defineOperation as unknown as (
  definition: Record<string, unknown>,
) => unknown;
const readUser = define({
  name: "users.get",
  entity: "users",
  method: "GET",
  authorize: () => true,
  execute: () => null,
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
      use: record("use"),
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
  beforeEach(() => {
    mocks.createDatabaseState.mockReset();
    mocks.loadDefaultDatabaseSchema.mockReset();
  });

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

  test("accepts omitted and empty configuration without doing I/O during registration", () => {
    for (const definition of [database(), database({}), database(undefined)]) {
      expect(definition).toMatchObject({ name: "database", config: {} });
    }
    new DatabasePlugin();
    expect(mocks.loadDefaultDatabaseSchema).not.toHaveBeenCalled();
    expect(mocks.createDatabaseState).not.toHaveBeenCalled();
  });

  test.each([undefined, {}, { schema: undefined }, { routes: false }] as const)(
    "loads the conventional schema and serves nothing over HTTP with config=%j",
    async (config) => {
      mocks.loadDefaultDatabaseSchema.mockResolvedValue(routedSchema);
      const { plugin, routes } = await registerRoutes(config);
      expect(routes).toEqual([]);
      expect(plugin.getEndpoints()).toEqual({});
      expect(plugin.getSkipBodyParsingPrefixes().size).toBe(0);
      expect(plugin.clientConfig()).toEqual({});
      expect(plugin.exports()).toHaveProperty("operation");
      expect(mocks.loadDefaultDatabaseSchema).toHaveBeenCalledOnce();
      expect(mocks.createDatabaseState).toHaveBeenCalledWith(
        routedSchema,
        expect.any(Function),
      );
    },
  );

  test("never loads the convention when an explicit schema is supplied", async () => {
    await registerRoutes({ schema: routedSchema });
    expect(mocks.loadDefaultDatabaseSchema).not.toHaveBeenCalled();
  });

  test.each([null, false, 0, "", [], new Date()])(
    "rejects invalid config=%j rather than enabling defaults",
    (config) => {
      expect(() => database(config as never)).toThrow("configuration object");
      expect(() => new DatabasePlugin(config as never)).toThrow(
        "configuration object",
      );
      expect(mocks.loadDefaultDatabaseSchema).not.toHaveBeenCalled();
      expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    },
  );

  test.each([true, {}, [], { schema: () => undefined, modules: [{}] }])(
    "rejects routes=%j that is not the generated registry or false",
    (routes) => {
      const config = { schema, routes } as never;
      expect(() => database(config)).toThrow("databaseRoutes registry");
      expect(() => new DatabasePlugin(config)).toThrow(
        "databaseRoutes registry",
      );
    },
  );

  test.each([null, {}, { $tables: {} }])(
    "rejects an invalid explicit schema instead of falling back: %j",
    async (invalid) => {
      const plugin = new DatabasePlugin({ schema: invalid as never });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
        message: expect.stringContaining("defineSchema()"),
      });
      expect(mocks.loadDefaultDatabaseSchema).not.toHaveBeenCalled();
      expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    },
  );

  test("does not allocate or publish when default schema loading fails", async () => {
    const error = new Error("Default schema unavailable");
    mocks.loadDefaultDatabaseSchema.mockRejectedValue(error);
    const plugin = new DatabasePlugin();
    await expect(plugin.setup()).rejects.toBe(error);
    expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    expect(() => plugin.exports()).toThrow();
    const { router, routes } = fakeRouter();
    plugin.injectRoutes(router);
    expect(routes).toEqual([]);
  });

  test("shares one schema load across concurrent setup calls", async () => {
    const loaded = deferred<typeof routedSchema>();
    mocks.loadDefaultDatabaseSchema.mockReturnValue(loaded.promise);
    mocks.createDatabaseState.mockResolvedValue(candidate());
    const plugin = new DatabasePlugin();
    const first = plugin.setup();
    const second = plugin.setup();
    expect(mocks.loadDefaultDatabaseSchema).toHaveBeenCalledOnce();
    expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    loaded.resolve(routedSchema);
    await Promise.all([first, second]);
    expect(mocks.createDatabaseState).toHaveBeenCalledOnce();
  });

  test("does not create a pool when shutdown happens during schema loading", async () => {
    const loaded = deferred<typeof routedSchema>();
    mocks.loadDefaultDatabaseSchema.mockReturnValue(loaded.promise);
    const plugin = new DatabasePlugin();
    const setup = plugin.setup();
    const shutdown = plugin.shutdown();
    loaded.resolve(routedSchema);
    await expect(setup).rejects.toMatchObject({ category: "SETUP_FAILED" });
    await shutdown;
    expect(mocks.createDatabaseState).not.toHaveBeenCalled();
    expect(() => plugin.exports()).toThrow();
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

  test("uses the routes registry's schema without loading the convention", async () => {
    const routes = {
      schema: vi.fn(async () => ({ schema: routedSchema })),
      modules: [],
    };
    for (const config of [{ routes }, { routes, schema: routedSchema }]) {
      const { plugin } = await registerRoutes(config);
      expect(plugin.exports()).toHaveProperty("operation");
    }
    expect(routes.schema).toHaveBeenCalledTimes(2);
    expect(mocks.loadDefaultDatabaseSchema).not.toHaveBeenCalled();
    expect(mocks.createDatabaseState).toHaveBeenCalledWith(
      routedSchema,
      expect.any(Function),
    );
  });

  test("loads routes modules one at a time, in listed order", async () => {
    const first = deferred<Record<string, unknown>>();
    const loads: string[] = [];
    const plugin = new DatabasePlugin({
      routes: {
        schema: async () => ({ schema: routedSchema }),
        modules: [
          {
            file: "routes/a.ts",
            load: () => {
              loads.push("a");
              return first.promise;
            },
          },
          {
            file: "routes/b.ts",
            load: async () => {
              loads.push("b");
              return { readUser };
            },
          },
        ],
      },
    });
    mocks.createDatabaseState.mockResolvedValue(candidate());
    const setup = plugin.setup();
    await vi.waitFor(() => expect(loads).toEqual(["a"]));
    first.resolve({ helper: () => "not an operation" });
    await setup;

    expect(loads).toEqual(["a", "b"]);
    const { router, routes } = fakeRouter();
    plugin.injectRoutes(router);
    expect(routes).toEqual(["use /operations"]);
    expect(plugin.getEndpoints()).toEqual({
      "users.get": "/api/database/operations/users.get",
    });
    expect(plugin.clientConfig()).toEqual({
      operations: { "users.get": "GET" },
    });
    expect([...plugin.getSkipBodyParsingPrefixes()]).toEqual([
      "/api/database/operations",
    ]);
  });

  test("serves nothing when every declaration was skipped", async () => {
    const unguarded = define({
      name: "users.get",
      entity: "users",
      method: "GET",
      execute: () => null,
    });
    const { plugin, routes } = await registerRoutes({
      routes: {
        schema: async () => ({ schema: routedSchema }),
        modules: [
          { file: "routes/users.ts", load: async () => ({ unguarded }) },
        ],
      },
    });
    expect(routes).toEqual([]);
    expect(plugin.getEndpoints()).toEqual({});
    expect(plugin.clientConfig()).toEqual({});
  });

  test("publishes no client config when setup failed", async () => {
    mocks.createDatabaseState.mockRejectedValue(new Error("boom"));
    const plugin = new DatabasePlugin({ schema: routedSchema });
    await expect(plugin.setup()).rejects.toThrow();

    expect(plugin.clientConfig()).toEqual({});
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
