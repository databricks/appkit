import {
  createMockUserContext,
  createStubTaskManager,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as executionContext from "../../../context/execution-context";
import { ServiceContext } from "../../../context/service-context";
import { TaskManager } from "../../../tasks";
import { AnalyticsPlugin } from "../analytics";
import type { IAnalyticsConfig } from "../types";

const { mockCacheInstance } = vi.hoisted(() => ({
  mockCacheInstance: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_k: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(() => "test-key"),
  },
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("AnalyticsPlugin durable query task — OBO recovery contract", () => {
  let config: IAnalyticsConfig;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  let taskStub: ReturnType<typeof createStubTaskManager>;
  let getInstanceSyncSpy: ReturnType<typeof vi.spyOn>;
  let plugin: AnalyticsPlugin;

  const baseInput = {
    queryKey: "test-q",
    statement: "SELECT 1",
    executorKey: "user:obo",
    isAsUser: true,
    formatType: "result" as const,
  };

  beforeEach(async () => {
    config = { timeout: 5000 };
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
    taskStub = createStubTaskManager();
    getInstanceSyncSpy = vi
      .spyOn(TaskManager, "getInstanceSync")
      .mockReturnValue(taskStub as unknown as TaskManager);

    plugin = new AnalyticsPlugin(config);
    await plugin.setup();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    getInstanceSyncSpy?.mockRestore();
  });

  test("throws when OBO task runs with ctx.context null on recovery", async () => {
    const stubCtx = {
      context: null,
      isRecovery: true,
      previousEvents: [] as unknown[],
      emit: vi.fn(),
      heartbeat: vi.fn(),
    };

    const runQueryTask = (
      plugin as unknown as {
        _runQueryTask: (
          input: typeof baseInput,
          ctx: typeof stubCtx,
        ) => Promise<unknown>;
      }
    )._runQueryTask.bind(plugin);

    const outcome = await runQueryTask(baseInput, stubCtx).then(
      () => ({ threw: false as const, message: "" }),
      (e: unknown) => ({
        threw: true as const,
        message: e instanceof Error ? e.message : String(e),
      }),
    );

    expect(outcome.threw).toBe(true);
    expect(outcome.message).toMatch(/OBO/i);
    expect(outcome.message).toMatch(/service[-\s]principal/i);
    expect(outcome.message).toMatch(/context:\s*req/i);
  });

  test("delegates OBO execution through runInUserContext to _runQueryInner", async () => {
    const mockUserContext = createMockUserContext();
    const stubCtx = {
      context: mockUserContext,
      isRecovery: true,
      previousEvents: [] as unknown[],
      emit: vi.fn(),
      heartbeat: vi.fn(),
    };

    const fakeResult = { ok: true, source: "_runQueryInner" };
    const runInSpy = vi.spyOn(executionContext, "runInUserContext");
    const innerSpy = vi
      .spyOn(
        plugin as unknown as { _runQueryInner: () => Promise<unknown> },
        "_runQueryInner",
      )
      .mockResolvedValue(fakeResult);

    try {
      const runQueryTask = (
        plugin as unknown as {
          _runQueryTask: (
            input: typeof baseInput,
            ctx: typeof stubCtx,
          ) => Promise<unknown>;
        }
      )._runQueryTask.bind(plugin);

      const result = await runQueryTask(baseInput, stubCtx);

      expect(result).toEqual(fakeResult);
      expect(runInSpy).toHaveBeenCalledOnce();
      expect(runInSpy).toHaveBeenCalledWith(
        mockUserContext,
        expect.any(Function),
      );
      expect(innerSpy).toHaveBeenCalledOnce();
      expect(innerSpy).toHaveBeenCalledWith(baseInput, stubCtx);
    } finally {
      runInSpy.mockRestore();
      innerSpy.mockRestore();
    }
  });
});
