import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@/domain";
import { Flush } from "@/flush/flush-manager";
import { FlushWorker } from "@/flush/flush-worker";
import type { IPCMessage } from "@/flush/types";
import { EventLog } from "@/persistence/event-log";
import { createRepository } from "@/persistence/repository";
import type { TaskRepository } from "@/persistence/repository/types";

// mock child_process
vi.mock("node:child_process", () => ({
  fork: vi.fn(),
}));

import { fork } from "node:child_process";

// helper to create a mock child process
function createMockChildProcess(pid: number = 12345) {
  const emitter = new EventEmitter();
  return {
    pid,
    connected: true,
    send: vi.fn(),
    kill: vi.fn(),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  };
}

describe("Flush", () => {
  let flush: Flush;
  let mockChild: ReturnType<typeof createMockChildProcess>;

  const createFlush = (overrides = {}) =>
    new Flush({
      repository: { type: "sqlite", database: ":memory:" },
      flushIntervalMs: 1000,
      eventLogPath: "./event-log-test",
      maxBatchSize: 1000,
      maxFlushRetries: 3,
      retryBaseDelayMs: 100,
      circuitBreakerDurationMs: 1000,
      circuitBreakerThreshold: 3,
      healthCheckIntervalMs: 1000,
      maxRestarts: 3,
      restartDelayMs: 100,
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = createMockChildProcess();
    vi.mocked(fork).mockReturnValue(mockChild as any);
  });

  afterEach(async () => {
    if (flush) {
      // @ts-expect-error - accessing private property
      flush.isShuttingDown = true;
      // @ts-expect-error - accessing private property
      flush.stopHealthCheck();
    }
  });

  describe("initialize", () => {
    it("should spawn a fork process", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();

      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);

      await initPromise;

      expect(fork).toHaveBeenCalledTimes(1);
      expect(fork).toHaveBeenCalledWith(
        expect.stringContaining("flush-worker-entry.js"),
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            FLUSH_CONFIG: expect.any(String),
          }),
        }),
      );
    });

    it("should start health check after spawn", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();

      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);

      await initPromise;

      // @ts-expect-error - accessing private property
      expect(flush.healthCheckTimer).not.toBeNull();
    });

    it("should reject if worker fails to start within timeout", async () => {
      flush = createFlush();

      mockChild.pid = undefined as any;

      const initPromise = flush.initialize();

      await expect(initPromise).rejects.toThrow("Worker failed to start");
    }, 10000);
  });

  describe("shutdown", () => {
    it("should send shutdown command to worker", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      const shutdownPromise = flush.shutdown(1000);

      setTimeout(() => {
        mockChild.emit("exit", 0, null);
      }, 10);

      await shutdownPromise;

      expect(mockChild.send).toHaveBeenCalledWith({
        type: "shutdown",
        payload: { timeoutMs: 1000 },
      });

      process.kill = originalKill;
    });

    it("should stop health check on shutdown", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      const shutdownPromise = flush.shutdown(1000);
      setTimeout(() => {
        mockChild.emit("exit", 0, null);
      }, 10);
      await shutdownPromise;

      // @ts-expect-error - accessing private property
      expect(flush.healthCheckTimer).toBeNull();

      process.kill = originalKill;
    });

    it("should force kill if worker does not exit within timeout", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      await flush.shutdown(50);

      expect(mockChild.kill).toHaveBeenCalledWith("SIGKILL");

      process.kill = originalKill;
    });

    it("should return immediately if worker is not alive", async () => {
      flush = createFlush();

      const result = await flush.shutdown(1000);

      expect(result).toBeUndefined();
      expect(mockChild.send).not.toHaveBeenCalled();
    });
  });

  describe("isAlive", () => {
    it("should return false if worker is null", () => {
      flush = createFlush();
      expect(flush.isAlive()).toBe(false);
    });

    it("should return false if worker has no pid", async () => {
      flush = createFlush();
      mockChild.pid = undefined as any;

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      expect(flush.isAlive()).toBe(false);
    });

    it("should return true if process exists", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      expect(flush.isAlive()).toBe(true);

      process.kill = originalKill;
    });

    it("should return false if process does not exist", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw new Error("ESRCH");
      });

      expect(flush.isAlive()).toBe(false);

      process.kill = originalKill;
    });
  });

  describe("respawn", () => {
    it("should respawn worker on unexpected exit", async () => {
      flush = createFlush({ restartDelayMs: 100 });

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      vi.mocked(fork).mockClear();

      const newMockChild = createMockChildProcess(99999);
      vi.mocked(fork).mockReturnValue(newMockChild as any);

      mockChild.emit("exit", 1, "SIGKILL");

      await new Promise((resolve) => setTimeout(resolve, 200));

      newMockChild.emit("message", { type: "ready" } as IPCMessage);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fork).toHaveBeenCalledTimes(1);
      expect(flush.getStatus().restartCount).toBe(1);
    });

    it("should not respawn if shutting down", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      vi.mocked(fork).mockClear();

      // @ts-expect-error - accessing private property
      flush.isShuttingDown = true;

      mockChild.emit("exit", 0, null);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(fork).not.toHaveBeenCalled();
    });

    it("should stop respawning after max restarts", async () => {
      flush = createFlush({ maxRestarts: 2, restartDelayMs: 100 });

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      for (let i = 0; i < 3; i++) {
        vi.mocked(fork).mockClear();
        const newMock = createMockChildProcess(10000 + i);
        vi.mocked(fork).mockReturnValue(newMock as any);

        mockChild.emit("exit", 1, null);
        await new Promise((resolve) => setTimeout(resolve, 200));

        if (i < 2) {
          newMock.emit("message", { type: "ready" } as IPCMessage);
          mockChild = newMock;
        }
      }

      expect(flush.getStatus().restartCount).toBeGreaterThanOrEqual(2);
    }, 10000);
  });

  describe("getWorkerStats", () => {
    it("should return null if worker is not alive", async () => {
      flush = createFlush();
      const stats = await flush.getWorkerStats();
      expect(stats).toBeNull();
    });

    it("should request stats via IPC", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      const statsPromise = flush.getWorkerStats();

      setTimeout(() => {
        mockChild.emit("message", {
          type: "stats",
          payload: {
            flushCount: 10,
            errorCount: 2,
            consecutiveErrors: 0,
            totalEntriesFlushed: 100,
            lastFlushAt: Date.now(),
            lastErrorAt: null,
            isRunning: true,
            isShuttingDown: false,
            isCircuitOpen: false,
          },
        } as IPCMessage);
      }, 10);

      const stats = await statsPromise;

      expect(mockChild.send).toHaveBeenCalledWith({ type: "get-stats" });
      expect(stats?.flushCount).toBe(10);
      expect(stats?.totalEntriesFlushed).toBe(100);

      process.kill = originalKill;
    });

    it("should return cached stats on timeout", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      // @ts-expect-error - accessing private property
      flush.lastStats = {
        flushCount: 5,
        errorCount: 1,
        consecutiveErrors: 0,
        totalEntriesFlushed: 50,
        lastFlushAt: Date.now(),
        lastErrorAt: null,
      };

      const stats = await flush.getWorkerStats();

      expect(stats?.flushCount).toBe(5);

      process.kill = originalKill;
    });
  });

  describe("getStatus", () => {
    it("should return current status", async () => {
      flush = createFlush();

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn();

      const status = flush.getStatus();

      expect(status).toEqual({
        isAlive: true,
        isShuttingDown: false,
        restartCount: 0,
        pid: 12345,
        lastStats: null,
      });

      process.kill = originalKill;
    });
  });

  describe("health check", () => {
    it("should trigger respawn when worker dies", async () => {
      flush = createFlush({ healthCheckInterval: 1000, restartDelayMs: 100 });

      const initPromise = flush.initialize();
      setTimeout(() => {
        mockChild.emit("message", { type: "ready" } as IPCMessage);
      }, 10);
      await initPromise;

      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw new Error("ESRCH");
      });

      vi.mocked(fork).mockClear();
      const newMock = createMockChildProcess(99999);
      vi.mocked(fork).mockReturnValue(newMock as any);

      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(fork).toHaveBeenCalled();

      process.kill = originalKill;
    }, 10000);
  });
});

describe("FlushWorker", () => {
  const eventLogPath = "./event-log-flush-test";
  const checkpointPath = `${eventLogPath}.flush-checkpoint`;
  const dbPath = "./tasks-flush-test.db";

  let worker: FlushWorker;
  let eventLog: EventLog;
  let repository: TaskRepository;

  const createEntries = (): EventLogEntry[] => [
    {
      timestamp: Date.now(),
      taskId: "task-001",
      type: "TASK_CREATED",
      name: "test-task",
      idempotencyKey: "idem-001",
      userId: "user-123",
      input: { test: "test" },
      executionOptions: { maxConcurrentExecutions: 1 },
      taskType: "user",
    },
    {
      timestamp: Date.now(),
      taskId: "task-002",
      type: "TASK_CREATED",
      name: "test-task",
      idempotencyKey: "idem-002",
      userId: "user-123",
      input: { test: "test" },
      executionOptions: { maxConcurrentExecutions: 1 },
      taskType: "user",
    },
    {
      timestamp: Date.now(),
      taskId: "task-001",
      type: "TASK_START",
      name: "test-task",
      idempotencyKey: "idem-001",
      userId: "user-123",
      taskType: "user",
    },
  ];

  const createWorker = async (overrides = {}) => {
    repository = await createRepository({ type: "sqlite", database: dbPath });
    return new FlushWorker(
      {
        flushIntervalMs: 1000,
        eventLogPath,
        maxBatchSize: 1000,
        maxFlushRetries: 3,
        retryBaseDelayMs: 100,
        circuitBreakerDurationMs: 1000,
        circuitBreakerThreshold: 3,
        healthCheckIntervalMs: 5000,
        maxRestarts: 3,
        restartDelayMs: 1000,
        ...overrides,
      },
      repository,
    );
  };

  const cleanup = async () => {
    const filesToDelete = [
      dbPath,
      checkpointPath,
      `${checkpointPath}.temp`,
      eventLogPath,
      `${eventLogPath}.checkpoint`,
    ];

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  };

  beforeEach(async () => {
    await cleanup();

    eventLog = new EventLog({ eventLogPath });
    await eventLog.initialize();

    const entries = createEntries();
    for (const entry of entries) {
      await eventLog.appendEntry(entry);
    }

    worker = await createWorker();
  });

  afterEach(async () => {
    worker?.stop();
    await repository?.close();
    await eventLog?.close(true);
    await cleanup();
  });

  describe("lifecycle", () => {
    it("should start and set isRunning to true", async () => {
      expect(worker.isRunning).toBe(false);
      await worker.start();
      expect(worker.isRunning).toBe(true);
    });

    it("should load checkpoint from file on start", async () => {
      await fs.promises.writeFile(checkpointPath, "5", "utf-8");

      await worker.start();
      await worker.flush();

      const stats = worker.getStats();
      expect(stats.totalEntriesFlushed).toBe(0);
    });

    it("should stop and clear the interval on stop", async () => {
      await worker.start();
      // @ts-expect-error - accessing private property
      expect(worker.flushInterval).not.toBeNull();

      worker.stop();
      // @ts-expect-error - accessing private property
      expect(worker.flushInterval).toBeNull();
    });

    it("should set isRunning to false on stop", async () => {
      await worker.start();
      expect(worker.isRunning).toBe(true);

      worker.stop();
      expect(worker.isRunning).toBe(false);
    });
  });

  describe("flush", () => {
    it("should flush batch to database", async () => {
      await worker.start();
      await worker.flush();

      const stats = worker.getStats();
      expect(stats.flushCount).toBe(1);
      expect(stats.totalEntriesFlushed).toBe(3);
    });

    it("should limit batch to max batch size", async () => {
      for (let i = 0; i < 10; i++) {
        await eventLog.appendEntry({
          timestamp: Date.now(),
          taskId: `task-extra-${i}`,
          type: "TASK_CREATED",
          name: "test-task",
          idempotencyKey: `idem-extra-${i}`,
          userId: "user-123",
          input: { test: "test" },
          executionOptions: { maxConcurrentExecutions: 1 },
          taskType: "user",
        });
      }

      const smallBatchWorker = await createWorker({ maxBatchSize: 5 });
      await smallBatchWorker.start();
      await smallBatchWorker.flush();

      const stats = smallBatchWorker.getStats();
      expect(stats.totalEntriesFlushed).toBe(5);

      smallBatchWorker.stop();
    });

    it("should update checkpoint after successful flush", async () => {
      await worker.start();
      await worker.flush();

      const checkpointContent = await fs.promises.readFile(
        checkpointPath,
        "utf-8",
      );
      expect(parseInt(checkpointContent, 10)).toBe(3);
    });

    it("should skip flush if no entries", async () => {
      await eventLog.close(true);
      eventLog = new EventLog({ eventLogPath });
      await eventLog.initialize();

      worker = await createWorker();
      await worker.start();
      await worker.flush();

      const stats = worker.getStats();
      expect(stats.flushCount).toBe(0);
    });

    it("should skip flush if not running and not shutting down", async () => {
      await worker.flush();

      const stats = worker.getStats();
      expect(stats.flushCount).toBe(0);
    });
  });

  describe("retry", () => {
    it("should retry flush on failure with exponential backoff", async () => {
      await worker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("DB error 1"))
        .mockRejectedValueOnce(new Error("DB error 2"))
        .mockResolvedValueOnce(undefined);

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      await worker.flush();

      expect(mockExecuteBatch).toHaveBeenCalledTimes(3);
      const stats = worker.getStats();
      expect(stats.flushCount).toBe(1);
      expect(stats.errorCount).toBe(2);
    });

    it("should stop retrying after maxFlushRetries", async () => {
      await worker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValue(new Error("Persistent error"));

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      await worker.flush();

      expect(mockExecuteBatch).toHaveBeenCalledTimes(3);
      const stats = worker.getStats();
      expect(stats.flushCount).toBe(0);
      expect(stats.errorCount).toBe(3);
    });

    it("should track error stats on failure", async () => {
      await worker.start();

      const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("DB error"));

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      await worker.flush();

      const stats = worker.getStats();
      expect(stats.errorCount).toBe(3);
      expect(stats.consecutiveErrors).toBe(3);
      expect(stats.lastErrorAt).not.toBeNull();
    });

    it("should reset consecutive errors on success", async () => {
      await worker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValue(undefined);

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      await worker.flush();

      const stats = worker.getStats();
      expect(stats.consecutiveErrors).toBe(0);
      expect(stats.errorCount).toBe(1);
    });
  });

  describe("circuit breaker", () => {
    it("should open circuit breaker after threshold errors", async () => {
      const cbWorker = await createWorker({
        circuitBreakerThreshold: 3,
        maxFlushRetries: 1,
      });
      await cbWorker.start();

      const mockExecuteBatch = vi.fn().mockRejectedValue(new Error("DB error"));

      // @ts-expect-error - accessing private property
      cbWorker.repository.executeBatch = mockExecuteBatch;

      await cbWorker.flush();
      await cbWorker.flush();
      await cbWorker.flush();

      const stats = cbWorker.getStats();
      expect(stats.isCircuitOpen).toBe(true);

      cbWorker.stop();
    });

    it("should block flushes while circuit breaker is open", async () => {
      const cbWorker = await createWorker({
        circuitBreakerThreshold: 1,
        maxFlushRetries: 1,
        circuitBreakerDurationMs: 10000,
      });
      await cbWorker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValue(undefined);

      // @ts-expect-error - accessing private property
      cbWorker.repository.executeBatch = mockExecuteBatch;

      await cbWorker.flush();
      await cbWorker.flush();

      expect(mockExecuteBatch).toHaveBeenCalledTimes(1);

      cbWorker.stop();
    });

    it("should reset circuit breaker after duration", async () => {
      const cbWorker = await createWorker({
        circuitBreakerThreshold: 1,
        maxFlushRetries: 1,
        circuitBreakerDurationMs: 1000,
      });
      await cbWorker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValue(undefined);

      // @ts-expect-error - accessing private property
      cbWorker.repository.executeBatch = mockExecuteBatch;

      await cbWorker.flush();
      expect(cbWorker.getStats().isCircuitOpen).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      await cbWorker.flush();
      expect(cbWorker.getStats().isCircuitOpen).toBe(false);
      expect(mockExecuteBatch).toHaveBeenCalledTimes(2);

      cbWorker.stop();
    }, 10000);
  });

  describe("graceful shutdown", () => {
    it("should drain remaining events on shutdown", async () => {
      await worker.start();

      await worker.gracefulShutdown(5000);

      const stats = worker.getStats();
      expect(stats.totalEntriesFlushed).toBe(3);
    });

    it("should respect timeout on graceful shutdown", async () => {
      await worker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValue(new Error("Persistent error"));

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      const startTime = Date.now();
      await worker.gracefulShutdown(200);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(500);
    });

    it("should close repository on graceful shutdown", async () => {
      await worker.start();

      // @ts-expect-error - accessing private property
      const closeSpy = vi.spyOn(worker.repository, "close");

      await worker.gracefulShutdown(1000);

      expect(closeSpy).toHaveBeenCalled();
    });

    it("should allow flush during shutdown even if not running", async () => {
      await worker.start();
      worker.stop();

      // @ts-expect-error - accessing private property
      worker.isShuttingDown = true;

      await worker.flush();

      const stats = worker.getStats();
      expect(stats.totalEntriesFlushed).toBe(3);
    });
  });

  describe("checkpoint", () => {
    it("should create checkpoint file if not exists", async () => {
      try {
        fs.unlinkSync(checkpointPath);
      } catch {
        // ignore
      }

      await worker.start();
      await worker.flush();

      expect(fs.existsSync(checkpointPath)).toBe(true);
    });

    it("should handle invalid checkpoint values", async () => {
      await fs.promises.writeFile(checkpointPath, "invalid", "utf-8");

      await worker.start();
      await worker.flush();

      const stats = worker.getStats();
      expect(stats.totalEntriesFlushed).toBe(3);
    });

    it("should write checkpoint file atomically", async () => {
      await worker.start();
      await worker.flush();

      expect(fs.existsSync(`${checkpointPath}.temp`)).toBe(false);
      expect(fs.existsSync(checkpointPath)).toBe(true);
    });
  });

  describe("stats", () => {
    it("should track flushCount", async () => {
      await worker.start();

      expect(worker.getStats().flushCount).toBe(0);

      await worker.flush();
      expect(worker.getStats().flushCount).toBe(1);
    });

    it("should track totalEntriesFlushed", async () => {
      await worker.start();

      expect(worker.getStats().totalEntriesFlushed).toBe(0);

      await worker.flush();
      expect(worker.getStats().totalEntriesFlushed).toBe(3);
    });

    it("should track errorCount", async () => {
      await worker.start();

      const mockExecuteBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValue(undefined);

      // @ts-expect-error - accessing private property
      worker.repository.executeBatch = mockExecuteBatch;

      await worker.flush();

      expect(worker.getStats().errorCount).toBe(1);
    });

    it("should expose stats via getStats method", async () => {
      await worker.start();
      await worker.flush();

      const stats = worker.getStats();

      expect(stats).toMatchObject({
        flushCount: 1,
        errorCount: 0,
        consecutiveErrors: 0,
        totalEntriesFlushed: 3,
        isRunning: true,
        isShuttingDown: false,
        isCircuitOpen: false,
      });
      expect(stats.lastFlushAt).not.toBeNull();
      expect(stats.lastErrorAt).toBeNull();
    });
  });
});
