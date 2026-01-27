import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, userId } from "@/core/branded";
import type { TaskEvent } from "@/domain/events";
import type { TaskDefinition, TaskHandlerContext } from "@/domain/handler";
import type { Task } from "@/domain/task";
import { TaskSystem, type TaskSystemConfig } from "@/execution/system";
import type { TaskRunParams } from "@/execution/types";

// mock the flush class to avoid forking real processes in tests
vi.mock("@/flush/flush-manager", () => ({
  Flush: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn().mockReturnValue(false),
    getStats: vi.fn().mockReturnValue({
      process: {
        isAlive: false,
        pid: null,
        restartCount: 0,
        isShuttingDown: false,
      },
      worker: null,
    }),
    getStatus: vi.fn().mockReturnValue({
      isAlive: false,
      isShuttingDown: false,
      restartCount: 0,
      pid: null,
      lastStats: null,
    }),
  })),
}));

// mock the repository
vi.mock("@/persistence/repository", () => ({
  createRepository: vi.fn().mockImplementation(() => ({
    type: "sqlite",
    isInitialized: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    executeBatch: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    findStaleTasks: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

async function collectStreamEvents(
  task: Task & {
    stream?: (options?: {
      lastSeq?: number;
      signal?: AbortSignal;
    }) => AsyncGenerator<TaskEvent, void, unknown>;
  },
  timeoutMs: number = 5_000,
): Promise<TaskEvent[]> {
  if (!task.stream) {
    throw new Error("Task stream is undefined");
  }

  const events: TaskEvent[] = [];
  const collectPromise = (async () => {
    for await (const event of task.stream!()) {
      events.push(event);
    }
    return events;
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(`Timed out waiting for task stream after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  return Promise.race([collectPromise, timeoutPromise]);
}

const basicTaskDefinition: TaskDefinition = {
  name: "basic-task",
  handler: async function* (_input: unknown, _context: TaskHandlerContext) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield { type: "progress", message: "Working..." };
    yield { type: "complete", result: "Done" };
  },
  defaultOptions: {},
};

const streamingTaskDefinition: TaskDefinition = {
  name: "streaming-task",
  handler: async function* (_input: unknown, _context: TaskHandlerContext) {
    yield { type: "progress", message: "Step 1" };
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield { type: "progress", message: "Step 2" };
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield { type: "progress", message: "Step 3" };
    yield { type: "complete", result: "Success" };
  },
  defaultOptions: {},
};

describe("TaskSystem", () => {
  let taskSystem: TaskSystem;

  const testConfig: TaskSystemConfig = {
    eventLog: {
      eventLogPath: "./test-event-log",
    },
    executor: {
      heartbeatIntervalMs: 1000,
    },
    shutdown: {
      gracePeriodMs: 5000,
      pollIntervalMs: 50,
    },
  };

  beforeEach(async () => {
    taskSystem = new TaskSystem(testConfig);
    await taskSystem.initialize();
  });

  afterEach(async () => {
    await taskSystem.shutdown({ deleteFiles: true, force: true });
  });

  describe("registerTask", () => {
    it("should register a task and return template", () => {
      const template = taskSystem.registerTask(basicTaskDefinition);

      expect(template.name).toBe("basic-task");
      expect(typeof template.run).toBe("function");
      expect(typeof template.recover).toBe("function");
    });

    it("should throw when registering duplicate task name", () => {
      taskSystem.registerTask(basicTaskDefinition);

      expect(() => taskSystem.registerTask(basicTaskDefinition)).toThrow(
        "Task basic-task already registered",
      );
    });
  });

  describe("getTemplate", () => {
    it("should return registered template", () => {
      taskSystem.registerTask(basicTaskDefinition);

      const template = taskSystem.getTemplate("basic-task");
      expect(template).not.toBeNull();
      expect(template?.name).toBe("basic-task");
    });

    it("should return null for unregistered template", () => {
      const template = taskSystem.getTemplate("unknown");
      expect(template).toBeNull();
    });
  });

  describe("run", () => {
    it("should run a task", async () => {
      const template = taskSystem.registerTask(basicTaskDefinition);

      const params: TaskRunParams = {
        input: { data: "test" },
        userId: userId("user-123"),
      };

      const task = await template.run(params);

      expect(task).toBeDefined();
      expect(task.name).toBe("basic-task");
      expect(task.userId).toBe("user-123");
    });

    it("should stream task events from execution", async () => {
      const template = taskSystem.registerTask(streamingTaskDefinition);

      const task = await template.run({
        input: {},
        userId: userId("user-123"),
      });

      const events = await collectStreamEvents(task as any);

      expect(events.length).toBeGreaterThanOrEqual(4); // created + progress*3 + complete
      expect(events[0].type).toBe("created");
      expect(events.some((e) => e.type === "progress")).toBe(true);
      expect(events[events.length - 1].type).toBe("complete");
    });
  });

  describe("recover", () => {
    it("should return null when task not found", async () => {
      const template = taskSystem.registerTask(basicTaskDefinition);

      const result = await template.recover({
        idempotencyKey: idempotencyKey("non-existent"),
        userId: userId("user-123"),
      });

      expect(result).toBeNull();
    });
  });

  describe("deduplication", () => {
    it("should return existing task when running duplicate", async () => {
      const template = taskSystem.registerTask(streamingTaskDefinition);

      const params: TaskRunParams = {
        input: { data: "test" },
        userId: userId("user-123"),
      };

      const task1 = await template.run(params);

      // wait a bit for task to start
      await new Promise((resolve) => setTimeout(resolve, 20));

      const task2 = await template.run(params);

      expect(task2.id).toBe(task1.id);
    });

    it("should connect to existing stream when duplicate", async () => {
      const template = taskSystem.registerTask(streamingTaskDefinition);

      const params: TaskRunParams = {
        input: {},
        userId: userId("user-123"),
      };

      const task1 = await template.run(params);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const task2 = await template.run(params);
      expect(task2.id).toBe(task1.id);

      const events = await collectStreamEvents(task2 as any);
      expect(events.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("custom events", () => {
    it("should handle custom events from handler", async () => {
      const customEventTask: TaskDefinition = {
        name: "custom-event-task",
        handler: async function* () {
          yield {
            type: "custom",
            eventName: "query-submitted",
            payload: { statementId: "stmt-123" },
          };
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield {
            type: "custom",
            eventName: "rows-processed",
            payload: { count: 5000 },
          };
          yield { type: "complete", result: { totalRows: 10000 } };
        },
        defaultOptions: {},
      };

      const template = taskSystem.registerTask(customEventTask);
      const task = await template.run({
        input: {},
        userId: userId("user-123"),
      });

      const events = await collectStreamEvents(task as any);

      const customEvents = events.filter((e) => e.type === "custom");
      expect(customEvents.length).toBe(2);
      expect(customEvents[0].eventName).toBe("query-submitted");
      expect(customEvents[1].eventName).toBe("rows-processed");
    });
  });

  describe("shutdown", () => {
    it("should wait for running tasks during graceful shutdown", async () => {
      let taskCompleted = false;

      const slowTask: TaskDefinition = {
        name: "slow-task",
        handler: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 200));
          taskCompleted = true;
          yield { type: "complete", result: "done" };
        },
        defaultOptions: {},
      };

      const template = taskSystem.registerTask(slowTask);
      await template.run({ input: {}, userId: userId("user-123") });

      // wait for task to start (executor tick interval is 100ms, so wait longer)
      await new Promise((resolve) => setTimeout(resolve, 150));

      await taskSystem.shutdown({ deleteFiles: true });

      expect(taskCompleted).toBe(true);
    });

    it("should force abort after grace period expires", async () => {
      const shortGraceSystem = new TaskSystem({
        ...testConfig,
        shutdown: { gracePeriodMs: 100, pollIntervalMs: 20 },
      });
      await shortGraceSystem.initialize();

      let taskCompleted = false;

      const verySlowTask: TaskDefinition = {
        name: "very-slow-task",
        handler: async function* (_input, context) {
          for (let i = 0; i < 50; i++) {
            if (context?.signal?.aborted) {
              yield { type: "cancelled", message: "Aborted" };
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          taskCompleted = true;
          yield { type: "complete", result: "done" };
        },
        defaultOptions: {},
      };

      const template = shortGraceSystem.registerTask(verySlowTask);
      await template.run({ input: {}, userId: userId("user-123") });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const startTime = Date.now();
      await shortGraceSystem.shutdown({ deleteFiles: true });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000);
      expect(taskCompleted).toBe(false);
    });

    it("should immediately abort with force: true", async () => {
      let taskCompleted = false;

      const longTask: TaskDefinition = {
        name: "long-task",
        handler: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          taskCompleted = true;
          yield { type: "complete", result: "done" };
        },
        defaultOptions: {},
      };

      const template = taskSystem.registerTask(longTask);
      await template.run({ input: {}, userId: userId("user-123") });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const startTime = Date.now();
      await taskSystem.shutdown({ force: true, deleteFiles: true });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(500);
      expect(taskCompleted).toBe(false);
    });

    it("should reject new tasks during shutdown", async () => {
      const slowTask: TaskDefinition = {
        name: "blocking-task",
        handler: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          yield { type: "complete", result: "done" };
        },
        defaultOptions: {},
      };

      const template = taskSystem.registerTask(slowTask);
      await template.run({ input: {}, userId: userId("user-123") });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const shutdownPromise = taskSystem.shutdown({ deleteFiles: true });

      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(
        template.run({ input: { new: true }, userId: userId("user-2") }),
      ).rejects.toThrow("shutting down");

      await shutdownPromise;
    });

    it("should be idempotent - multiple shutdown calls are safe", async () => {
      await taskSystem.shutdown({ deleteFiles: true });
      await expect(
        taskSystem.shutdown({ deleteFiles: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe("shuttingDown", () => {
    it("should expose shuttingDown state", async () => {
      expect(taskSystem.shuttingDown).toBe(false);

      const slowTask: TaskDefinition = {
        name: "state-task",
        handler: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 300));
          yield { type: "complete", result: "done" };
        },
        defaultOptions: {},
      };

      const template = taskSystem.registerTask(slowTask);
      await template.run({ input: {}, userId: userId("user-123") });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const shutdownPromise = taskSystem.shutdown({ deleteFiles: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(taskSystem.shuttingDown).toBe(true);

      await shutdownPromise;
    });
  });

  describe("getStats", () => {
    it("should return comprehensive statistics", async () => {
      const template = taskSystem.registerTask(basicTaskDefinition);
      await template.run({ input: {}, userId: userId("user-123") });

      const stats = taskSystem.getStats();

      expect(stats.system.status).toBe("running");
      expect(stats.system.startedAt).toBeDefined();
      expect(stats.tasks).toBeDefined();
      expect(stats.scheduler).toBeDefined();
      expect(stats.registry.templates).toBe(1);
      expect(stats.components).toBeDefined();
    });
  });
});
