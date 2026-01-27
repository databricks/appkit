import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@/domain/events";
import { LakebaseTaskRepository } from "@/persistence/repository/lakebase/repository";
import type { LakebaseConnector } from "@/persistence/repository/lakebase/types";

describe("LakebaseTaskRepository", () => {
  let repository: LakebaseTaskRepository;
  let mockConnector: LakebaseConnector;
  let queryResults: Map<string, unknown[]>;

  beforeEach(() => {
    queryResults = new Map();

    // create a properly typed mock query function
    const mockQueryFn = vi
      .fn()
      .mockImplementation(
        async <T = Record<string, unknown>>(
          sql: string,
          _params?: unknown[],
        ): Promise<{ rows: T[] }> => {
          // handle sequence query
          if (sql.includes("MAX(seq)")) {
            return { rows: [{ nextseq: 1 }] as unknown as T[] };
          }
          // return configured results or empty
          const key = sql.trim().split(" ")[0];
          return { rows: (queryResults.get(key) ?? []) as T[] };
        },
      );

    // create mock transaction function
    const mockTransactionFn = vi
      .fn()
      .mockImplementation(
        async <T>(
          fn: (client: LakebaseConnector) => Promise<T>,
        ): Promise<T> => {
          return fn(mockConnector);
        },
      );

    mockConnector = {
      query: mockQueryFn,
      transaction: mockTransactionFn,
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as LakebaseConnector;

    repository = new LakebaseTaskRepository({
      type: "lakebase",
      connector: mockConnector,
    });
  });

  describe("initialization", () => {
    it("should initialize and run migrations", async () => {
      await repository.initialize();
      expect(repository.isInitialized).toBe(true);

      // should have called query for CREATE TABLE statements
      expect(mockConnector.query).toHaveBeenCalled();
    });
  });

  describe("executeBatch", () => {
    it("should execute entries in a transaction", async () => {
      await repository.initialize();

      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: Date.now(),
          taskType: "user",
        },
      ];

      await repository.executeBatch(entries);
      expect(mockConnector.transaction).toHaveBeenCalled();
    });

    it("should skip empty batch", async () => {
      await repository.initialize();
      await repository.executeBatch([]);
      expect(mockConnector.transaction).not.toHaveBeenCalled();
    });
  });

  describe("findById", () => {
    it("should query and return task", async () => {
      await repository.initialize();

      queryResults.set("SELECT", [
        {
          task_id: "task-001",
          name: "test-task",
          status: "created",
          type: "user",
          idempotency_key: "idem-001",
          user_id: "user-123",
          input_data: "{}",
          created_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
          attempt: 0,
          execution_options: null,
          result: null,
          error: null,
          started_at: null,
          completed_at: null,
        },
      ]);

      const task = await repository.findById("task-001" as any);
      expect(task).not.toBeNull();
      expect(task?.id).toBe("task-001");
    });

    it("should return null for non-existent task", async () => {
      await repository.initialize();
      queryResults.set("SELECT", []);

      const task = await repository.findById("non-existent" as any);
      expect(task).toBeNull();
    });
  });

  describe("healthCheck", () => {
    it("should delegate to connector", async () => {
      const result = await repository.healthCheck();
      expect(result).toBe(true);
      expect(mockConnector.healthCheck).toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should close connector and update state", async () => {
      await repository.initialize();
      await repository.close();

      expect(repository.isInitialized).toBe(false);
      expect(mockConnector.close).toHaveBeenCalled();
    });
  });
});
