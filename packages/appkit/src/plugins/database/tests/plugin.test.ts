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

  test("registers no generated routes unless they are turned on", async () => {
    for (const crudRoutes of [undefined, false] as const) {
      const { routes } = await registerRoutes({
        schema: routedSchema,
        crudRoutes,
      });
      expect(routes).toEqual([]);
    }
  });

  test("registers reads for every table or an explicit subset", async () => {
    const assertNames = () => {
      database({
        schema: routedSchema,
        crudRoutes: {
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
        crudRoutes: { tables: ["missing"] },
      });
      database({
        schema: routedSchema,
        // @ts-expect-error only a declared table can shape its own responses
        hooks: { missing: { serialize: (row) => row } },
      });
    };
    void assertNames;

    const all = await registerRoutes({
      schema: routedSchema,
      crudRoutes: true,
    });
    expect(all.routes).toEqual([
      "get /users",
      "get /users/:id",
      "get /notes",
      "get /notes/:id",
      // A table without a primary key cannot address a single row.
      "get /events",
    ]);

    const subset = await registerRoutes({
      schema: routedSchema,
      crudRoutes: { tables: ["notes"] },
    });
    expect(subset.routes).toEqual(["get /notes", "get /notes/:id"]);
  });

  test("registers only explicitly enabled writes", async () => {
    const allWrites = await registerRoutes({
      schema: routedSchema,
      crudRoutes: { tables: ["users", "events"], writes: true },
    });
    expect(allWrites.routes).toEqual([
      "get /users",
      "post /users",
      "get /users/:id",
      "patch /users/:id",
      "delete /users/:id",
      "get /events",
      "post /events",
    ]);
    // Upsert stays programmatic; no generated route ever performs one.
    expect(allWrites.routes.join()).not.toContain("upsert");
    expect(allWrites.plugin.getEndpoints()).toMatchObject({
      "users.create": "/api/database/users",
      "users.update": "/api/database/users/:id",
      "users.delete": "/api/database/users/:id",
    });

    const constrained = await registerRoutes({
      schema: routedSchema,
      crudRoutes: {
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
        crudRoutes: { tables } as unknown as { tables: ["users"] },
      });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
      });
    }
  });

  test("fails setup on write exposure it cannot honor", async () => {
    const invalid = [
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
    for (const crudRoutes of invalid) {
      const plugin = new DatabasePlugin({
        schema: routedSchema,
        crudRoutes: crudRoutes as never,
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

  test("refuses to route names it cannot serve unambiguously", async () => {
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
        crudRoutes: true,
      });
      await expect(plugin.setup()).rejects.toMatchObject({
        category: "SETUP_FAILED",
      });
    }
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
