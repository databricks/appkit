import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { defineSchema } from "../../../database/schema-builder";

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
