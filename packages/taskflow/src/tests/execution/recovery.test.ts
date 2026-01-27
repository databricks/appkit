import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import type { StreamManager } from "@/delivery/stream";
import type { TaskEvent } from "@/domain/events";
import type { TaskDefinition } from "@/domain/handler";
import { Task } from "@/domain/task";
import type { TaskExecutor } from "@/execution/executor";
import { TaskRecovery } from "@/execution/recovery";
import type { RecoveryConfig } from "@/execution/types";
import type { Guard } from "@/guard/guard";
import type {
  StoredEvent,
  TaskRepository,
} from "@/persistence/repository/types";

function createMockTask(options?: {
  id?: string;
  name?: string;
  userId?: string;
  status?: "created" | "running" | "completed" | "failed" | "cancelled";
  type?: "user" | "background";
  lastHeartbeatAt?: Date;
}): Task {
  const task = new Task({
    name: taskName(options?.name ?? "test-task"),
    input: { data: "test" },
    userId: userId(options?.userId ?? "user-123"),
    type: options?.type ?? "user",
  });

  // override status and other fields if provided
  if (options?.status) {
    (task as any)._status = options.status;
  }
  if (options?.lastHeartbeatAt) {
    (task as any)._lastHeartbeatAt = options.lastHeartbeatAt;
  }

  return task;
}

function createMockRepository(): TaskRepository {
  return {
    type: "sqlite",
    isInitialized: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    executeBatch: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    findStaleTasks: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockGuard(): Guard {
  return {
    acquireRecoverySlot: vi.fn(),
    releaseRecoverySlot: vi.fn(),
  } as unknown as Guard;
}

function createMockStreamManager(): StreamManager {
  return {
    push: vi.fn(),
    getOrCreate: vi.fn(),
    close: vi.fn(),
  } as unknown as StreamManager;
}

function createMockExecutor(): TaskExecutor {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskExecutor;
}

describe("TaskRecovery", () => {
  let recovery: TaskRecovery;
  let mockRepository: TaskRepository;
  let mockGuard: Guard;
  let mockStreamManager: StreamManager;
  let mockExecutor: TaskExecutor;
  let definitions: Map<string, TaskDefinition>;

  const fastConfig: Partial<RecoveryConfig> = {
    enabled: true,
    backgroundPollIntervalMs: 100,
    staleThresholdMs: 1000,
    batchSize: 5,
    completionTimeoutMs: 5000,
    heartbeatIntervalMs: 500,
  };

  beforeEach(() => {
    definitions = new Map();
    mockRepository = createMockRepository();
    mockGuard = createMockGuard();
    mockStreamManager = createMockStreamManager();
    mockExecutor = createMockExecutor();

    recovery = new TaskRecovery(fastConfig, {
      guard: mockGuard,
      repository: mockRepository,
      streamManager: mockStreamManager,
      executor: mockExecutor,
      getDefinition: (name) => definitions.get(name),
    });
  });

  afterEach(() => {
    recovery.stopBackgroundRecovery();
    vi.clearAllMocks();
  });

  describe("configuration", () => {
    it("should use default config when not provided", () => {
      const defaultRecovery = new TaskRecovery(undefined, {
        guard: mockGuard,
        repository: mockRepository,
        streamManager: mockStreamManager,
        executor: mockExecutor,
        getDefinition: () => undefined,
      });

      const stats = defaultRecovery.getStats();
      expect(stats.config.enabled).toBe(true);
      expect(stats.config.pollIntervalMs).toBe(60000);
    });

    it("should merge custom config with defaults", () => {
      const stats = recovery.getStats();
      expect(stats.config.enabled).toBe(true);
      expect(stats.config.pollIntervalMs).toBe(100);
      expect(stats.config.staleThresholdMs).toBe(1000);
    });
  });

  describe("startBackgroundRecovery", () => {
    it("should start background recovery interval", () => {
      recovery.startBackgroundRecovery();
      expect(() => recovery.startBackgroundRecovery()).not.toThrow();
    });

    it("should not start if already running", () => {
      recovery.startBackgroundRecovery();
      recovery.startBackgroundRecovery();
    });

    it("should not start if disabled", () => {
      const disabledRecovery = new TaskRecovery(
        { ...fastConfig, enabled: false },
        {
          guard: mockGuard,
          repository: mockRepository,
          streamManager: mockStreamManager,
          executor: mockExecutor,
          getDefinition: () => undefined,
        },
      );

      disabledRecovery.startBackgroundRecovery();
      const stats = disabledRecovery.getStats();
      expect(stats.config.enabled).toBe(false);
    });
  });

  describe("stopBackgroundRecovery", () => {
    it("should stop and clear interval", () => {
      recovery.startBackgroundRecovery();
      recovery.stopBackgroundRecovery();
    });

    it("should do nothing if not running", () => {
      recovery.stopBackgroundRecovery();
    });
  });

  describe("recoverBackgroundTasks", () => {
    it("should find and recover stale background tasks", async () => {
      const staleTask = createMockTask({
        type: "background",
        status: "running",
        lastHeartbeatAt: new Date(Date.now() - 10000),
      });

      vi.mocked(mockRepository.findStaleTasks).mockResolvedValue([staleTask]);

      definitions.set("test-task", {
        name: "test-task",
        handler: async function* () {
          yield { type: "complete", message: "Recovered" };
        },
        defaultOptions: {},
      });

      await recovery.recoverBackgroundTasks();

      expect(mockGuard.acquireRecoverySlot).toHaveBeenCalled();
      expect(mockGuard.releaseRecoverySlot).toHaveBeenCalled();

      const stats = recovery.getStats();
      expect(stats.outcomes.background).toBe(1);
    });

    it("should only recover background tasks, not user tasks", async () => {
      const userTask = createMockTask({
        type: "user",
        status: "running",
        lastHeartbeatAt: new Date(Date.now() - 10000),
      });

      vi.mocked(mockRepository.findStaleTasks).mockResolvedValue([userTask]);

      await recovery.recoverBackgroundTasks();

      expect(mockGuard.acquireRecoverySlot).not.toHaveBeenCalled();
    });

    it("should respect batch size limit", async () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createMockTask({
          type: "background",
          status: "running",
          name: `task-${i}`,
        }),
      );

      vi.mocked(mockRepository.findStaleTasks).mockResolvedValue(tasks);

      // register definitions for all tasks
      for (let i = 0; i < 10; i++) {
        definitions.set(`task-${i}`, {
          name: `task-${i}`,
          handler: async function* () {
            yield { type: "complete", message: "Done" };
          },
          defaultOptions: {},
        });
      }

      await recovery.recoverBackgroundTasks();

      // should only call acquireRecoverySlot 5 times
      expect(mockGuard.acquireRecoverySlot).toHaveBeenCalledTimes(5);
    });

    it("should skip if disabled", async () => {
      const disabledRecovery = new TaskRecovery(
        { ...fastConfig, enabled: false },
        {
          guard: mockGuard,
          repository: mockRepository,
          streamManager: mockStreamManager,
          executor: mockExecutor,
          getDefinition: () => undefined,
        },
      );

      await disabledRecovery.recoverBackgroundTasks();

      expect(mockRepository.findStaleTasks).not.toHaveBeenCalled();
    });

    it("should increment tasksFailed on error", async () => {
      const staleTask = createMockTask({
        type: "background",
        status: "running",
      });

      vi.mocked(mockRepository.findStaleTasks).mockResolvedValue([staleTask]);

      await recovery.recoverBackgroundTasks();

      const stats = recovery.getStats();
      expect(stats.outcomes.failed).toBe(1);
    });

    it("should update lastBackgroundScanAt", async () => {
      vi.mocked(mockRepository.findStaleTasks).mockResolvedValue([]);

      await recovery.recoverBackgroundTasks();

      const stats = recovery.getStats();
      expect(stats.background.lastScanAt).toBeDefined();
    });
  });

  describe("recoverStaleTask", () => {
    it("should use recover handler when available (smart recovery)", async () => {
      const staleTask = createMockTask({ status: "running" });
      let recoveryHandlerCalled = false;

      definitions.set("test-task", {
        name: "test-task",
        handler: async function* () {
          yield { type: "complete", message: "Execute" };
        },
        recover: async function* (_input, ctx) {
          recoveryHandlerCalled = true;
          expect(ctx.previousEvents).toBeDefined();
          expect(ctx.recoveryReason).toBe("stale");
          yield { type: "complete", message: "Recovered" };
        },
        defaultOptions: {},
      });

      vi.mocked(mockRepository.getEvents).mockResolvedValue([]);

      const events: TaskEvent[] = [];
      for await (const event of recovery.recoverStaleTask(staleTask)) {
        events.push(event);
      }

      expect(recoveryHandlerCalled).toBe(true);
      const stats = recovery.getStats();
      expect(stats.outcomes.byMethod.smartRecovery).toBe(1);
    });

    it("should use execute handler when no recover handler (re-execute)", async () => {
      const staleTask = createMockTask({ status: "running" });
      let executeHandlerCalled = false;

      definitions.set("test-task", {
        name: "test-task",
        handler: async function* () {
          executeHandlerCalled = true;
          yield { type: "complete", message: "Re-executed" };
        },
        defaultOptions: {},
      });

      vi.mocked(mockRepository.getEvents).mockResolvedValue([]);

      const events: TaskEvent[] = [];
      for await (const event of recovery.recoverStaleTask(staleTask)) {
        events.push(event);
      }

      expect(executeHandlerCalled).toBe(true);
      const stats = recovery.getStats();
      expect(stats.outcomes.byMethod.reexecution).toBe(1);
    });

    it("should yield previous events from DB before recovery", async () => {
      const staleTask = createMockTask({ status: "running" });

      const storedEvents: StoredEvent[] = [
        {
          id: "evt-1",
          taskId: staleTask.id,
          seq: 1,
          type: "TASK_PROGRESS",
          timestamp: new Date(),
          payload: { message: "Previous progress" },
        },
      ];

      definitions.set("test-task", {
        name: "test-task",
        handler: async function* () {
          yield { type: "complete", message: "Done" };
        },
        defaultOptions: {},
      });

      vi.mocked(mockRepository.getEvents).mockResolvedValue(storedEvents);

      const events: TaskEvent[] = [];
      for await (const event of recovery.recoverStaleTask(staleTask)) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("progress");
    });

    it("should throw if handler not found", async () => {
      const staleTask = createMockTask({
        status: "running",
        name: "unknown-task",
      });

      await expect(async () => {
        for await (const _ of recovery.recoverStaleTask(staleTask)) {
          // consume
        }
      }).rejects.toThrow("Handler for task unknown-task not found");
    });
  });

  describe("handleDatabaseCheck", () => {
    it("should return null if repository not initialized", async () => {
      (mockRepository as any).isInitialized = false;

      const generator = recovery.handleDatabaseCheck(
        idempotencyKey("test-key"),
        "user-123",
      );

      const result = await generator.next();
      expect(result.done).toBe(true);
      expect(result.value).toBeNull();
    });

    it("should return null if task not found", async () => {
      vi.mocked(mockRepository.findByIdempotencyKey).mockResolvedValue(null);

      const generator = recovery.handleDatabaseCheck(
        idempotencyKey("test-key"),
        "user-123",
      );

      const result = await generator.next();
      expect(result.done).toBe(true);
      expect(result.value).toBeNull();
    });

    it("should return null if userId does not match (security)", async () => {
      const task = createMockTask({ userId: "other-user" });
      vi.mocked(mockRepository.findByIdempotencyKey).mockResolvedValue(task);

      const generator = recovery.handleDatabaseCheck(
        idempotencyKey("test-key"),
        "user-123",
      );

      const result = await generator.next();
      expect(result.done).toBe(true);
      expect(result.value).toBeNull();
    });

    it("should stream from DB if task completed", async () => {
      const task = createMockTask({ userId: "user-123", status: "completed" });
      vi.mocked(mockRepository.findByIdempotencyKey).mockResolvedValue(task);
      vi.mocked(mockRepository.getEvents).mockResolvedValue([
        {
          id: "evt-1",
          taskId: task.id,
          seq: 1,
          type: "TASK_COMPLETE",
          timestamp: new Date(),
          payload: { message: "Done" },
        },
      ]);

      const generator = recovery.handleDatabaseCheck(
        task.idempotencyKey,
        "user-123",
      );

      const events: TaskEvent[] = [];
      let result = await generator.next();

      while (!result.done) {
        events.push(result.value);
        result = await generator.next();
      }

      expect(events.length).toBe(1);
      expect(result.value).toBe(task);
    });

    it("should stream from DB if task failed", async () => {
      const task = createMockTask({ userId: "user-123", status: "failed" });
      vi.mocked(mockRepository.findByIdempotencyKey).mockResolvedValue(task);
      vi.mocked(mockRepository.getEvents).mockResolvedValue([]);

      const generator = recovery.handleDatabaseCheck(
        task.idempotencyKey,
        "user-123",
      );

      let result = await generator.next();
      while (!result.done) {
        result = await generator.next();
      }

      expect(result.value).toBe(task);
    });
  });

  describe("isTaskAlive", () => {
    it("should return true if heartbeat is recent", () => {
      const task = createMockTask({
        lastHeartbeatAt: new Date(Date.now() - 100), // 100ms ago
      });

      const isAlive = recovery["isTaskAlive"](task);
      expect(isAlive).toBe(true);
    });

    it("should return false if no heartbeat", () => {
      const task = createMockTask();
      (task as any)._lastHeartbeatAt = undefined;

      const isAlive = recovery["isTaskAlive"](task);
      expect(isAlive).toBe(false);
    });

    it("should return false if heartbeat is old", () => {
      const task = createMockTask({
        lastHeartbeatAt: new Date(Date.now() - 10000), // 10s ago, threshold is 500ms
      });

      const isAlive = recovery["isTaskAlive"](task);
      expect(isAlive).toBe(false);
    });
  });

  describe("getStats", () => {
    it("should return recovery statistics", () => {
      const stats = recovery.getStats();

      expect(stats.config.enabled).toBe(true);
      expect(stats.config.pollIntervalMs).toBe(100);
      expect(stats.background.isScanning).toBe(false);
      expect(stats.outcomes.background).toBe(0);
      expect(stats.outcomes.user).toBe(0);
      expect(stats.outcomes.failed).toBe(0);
      expect(stats.outcomes.byMethod.smartRecovery).toBe(0);
      expect(stats.outcomes.byMethod.reexecution).toBe(0);
    });
  });
});
