import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { engineSubmit, engineShutdown, engineCreate } = vi.hoisted(() => {
  const engineSubmit = vi.fn(async () => ({
    taskId: "t-1",
    idempotencyKey: "ik-1",
  }));
  const engineShutdown = vi.fn(async () => {});
  const engineCreate = vi.fn(async (_config: unknown) => ({
    submit: engineSubmit,
    reconnect: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    cancelTask: vi.fn(),
    subscribe: vi.fn(),
    shutdown: engineShutdown,
    simulateCrash: vi.fn(),
    registerTask: vi.fn(),
  }));
  return { engineSubmit, engineShutdown, engineCreate };
});

vi.mock("../vendor-loader", () => ({
  loadVendorModule: vi.fn(async () => ({
    Engine: { create: engineCreate },
  })),
}));

const { taskLogger } = vi.hoisted(() => ({
  taskLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
  },
}));

vi.mock("../../logging/logger", () => ({
  createLogger: () => taskLogger,
}));

vi.mock("../../telemetry", () => ({
  SpanStatusCode: { OK: 1, ERROR: 2 },
  TelemetryManager: {
    getProvider: vi.fn().mockReturnValue({
      getMeter: vi.fn().mockReturnValue({
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      }),
      startActiveSpan: vi.fn(async (_name, _opts, fn) => {
        const span = {
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        };
        return fn(span);
      }),
    }),
  },
}));

import { mergeTaskDefaults, taskDefaults } from "../defaults";
import { TaskManager } from "../manager";

describe("TaskManager", () => {
  beforeEach(() => {
    engineSubmit.mockClear();
    engineShutdown.mockClear();
    engineCreate.mockClear();
  });

  afterEach(async () => {
    await TaskManager._resetForTests();
  });

  describe("opt-in", () => {
    test("returns null when config is omitted", async () => {
      const result = await TaskManager.initialize(undefined);
      expect(result).toBeNull();
      expect(engineCreate).not.toHaveBeenCalled();
      expect(TaskManager.getInstanceSync()).toBeNull();
    });

    test("returns null when config is false", async () => {
      const result = await TaskManager.initialize(false);
      expect(result).toBeNull();
      expect(engineCreate).not.toHaveBeenCalled();
      expect(TaskManager.getInstanceSync()).toBeNull();
    });

    test("boot() returns null when config is false", async () => {
      const result = await TaskManager.boot(false);
      expect(result).toBeNull();
    });

    test("initializes with defaults when config is true", async () => {
      const result = await TaskManager.initialize(true);
      expect(result).toBeInstanceOf(TaskManager);
      expect(engineCreate).toHaveBeenCalledWith(taskDefaults);
    });
  });

  describe("initialize", () => {
    test("is idempotent — second call returns the same instance", async () => {
      const a = await TaskManager.initialize(true);
      const b = await TaskManager.initialize(true);
      expect(a).toBe(b);
      expect(engineCreate).toHaveBeenCalledTimes(1);
    });

    test("merges user config over defaults", async () => {
      await TaskManager.initialize({
        storage: { backend: "lakebase", connectionString: "postgres://x" },
      });
      expect(engineCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: expect.objectContaining({ recoveryIntervalMs: 5000 }),
          storage: { backend: "lakebase", connectionString: "postgres://x" },
        }),
      );
    });
  });

  describe("getInstanceSync", () => {
    test("returns null before initialization", () => {
      expect(TaskManager.getInstanceSync()).toBeNull();
    });

    test("returns the instance after initialize", async () => {
      const instance = await TaskManager.initialize(true);
      expect(TaskManager.getInstanceSync()).toBe(instance);
    });
  });

  describe("shutdown", () => {
    test("is idempotent — second call is a no-op", async () => {
      const instance = (await TaskManager.initialize(true)) as TaskManager;
      await instance.shutdown();
      await instance.shutdown();
      expect(engineShutdown).toHaveBeenCalledTimes(1);
    });

    test("rejects further calls on a shut-down instance", async () => {
      const instance = (await TaskManager.initialize(true)) as TaskManager;
      await instance.shutdown();
      await expect(instance.start("foo", {})).rejects.toThrow(
        /has been shut down/,
      );
    });
  });

  describe("_resetForTests", () => {
    test("shuts down the previous engine before zeroing the pointer", async () => {
      await TaskManager.initialize(true);
      await TaskManager._resetForTests();
      expect(engineShutdown).toHaveBeenCalledTimes(1);
      expect(TaskManager.getInstanceSync()).toBeNull();
    });

    test("refuses to run when NODE_ENV=production", async () => {
      await TaskManager.initialize(true);
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await expect(TaskManager._resetForTests()).rejects.toThrow(/test-only/);
      } finally {
        process.env.NODE_ENV = orig;
      }
    });
  });

  describe("warnOnEphemeralStorage", () => {
    test("warns when SQLite + Databricks Apps env is detected", async () => {
      taskLogger.warn.mockClear();
      const orig = process.env.DATABRICKS_APP_NAME;
      process.env.DATABRICKS_APP_NAME = "myapp";
      try {
        await TaskManager.initialize(true);
        expect(taskLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Tasks configured with the SQLite backend"),
        );
      } finally {
        if (orig === undefined) delete process.env.DATABRICKS_APP_NAME;
        else process.env.DATABRICKS_APP_NAME = orig;
      }
    });

    test("does not warn on non-sqlite backend", async () => {
      taskLogger.warn.mockClear();
      const orig = process.env.DATABRICKS_APP_NAME;
      process.env.DATABRICKS_APP_NAME = "myapp";
      try {
        await TaskManager.initialize({
          storage: { backend: "lakebase", connectionString: "postgres://x" },
        });
        expect(taskLogger.warn).not.toHaveBeenCalled();
      } finally {
        if (orig === undefined) delete process.env.DATABRICKS_APP_NAME;
        else process.env.DATABRICKS_APP_NAME = orig;
      }
    });
  });
});

describe("mergeTaskDefaults", () => {
  test("returns defaults when user config is undefined", () => {
    expect(mergeTaskDefaults(undefined)).toBe(taskDefaults);
  });

  test("replaces storage wholesale (discriminated union)", () => {
    const merged = mergeTaskDefaults({
      storage: { backend: "lakebase", connectionString: "postgres://x" },
    });
    expect(merged.storage).toEqual({
      backend: "lakebase",
      connectionString: "postgres://x",
    });
    // The sqlite-specific `databasePath` from defaults must NOT leak in.
    expect(
      (merged.storage as Record<string, unknown>).databasePath,
    ).toBeUndefined();
  });

  test("shallow-merges engine and executor fields", () => {
    const merged = mergeTaskDefaults({
      engine: { recoveryIntervalMs: 9999 },
    });
    expect(merged.engine?.recoveryIntervalMs).toBe(9999);
    // Default field preserved.
    expect(merged.engine?.staleThresholdMs).toBe(30000);
  });

  test("only emits wal/admission/stream when present in user config", () => {
    const merged = mergeTaskDefaults({});
    expect(merged.wal).toBeUndefined();
    expect(merged.admission).toBeUndefined();
    expect(merged.stream).toBeUndefined();
  });
});
