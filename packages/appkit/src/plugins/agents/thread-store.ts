import { randomUUID } from "node:crypto";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Message, Thread, ThreadStore } from "shared";
import { captureTraceValue } from "../../telemetry/agent-tracing";

const tracer = () => trace.getTracer("@databricks/appkit-agent-tracing");

type MemoryOperation = "create" | "get" | "list" | "addMessage" | "delete";

async function traceMemoryOperation<T>(
  operationName: MemoryOperation,
  key: string,
  inputs: unknown,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    `thread.${operationName}`,
    {
      attributes: {
        "mlflow.spanType": "MEMORY",
        "appkit.memory.operation": operationName,
        "appkit.memory.store": "thread",
        "appkit.memory.key": key,
      },
    },
    async (span) => {
      const startedAt = Date.now();
      setCapturedAttribute(span, "mlflow.spanInputs", inputs);
      try {
        const result = await operation(span);
        setCapturedAttribute(
          span,
          "mlflow.spanOutputs",
          result === undefined ? { completed: true } : result,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setAttribute("appkit.memory.state", "failed");
        recordSafeFailure(span, error, "Thread store operation failed");
        throw error;
      } finally {
        span.setAttribute(
          "appkit.memory.duration_ms",
          Math.max(0, Date.now() - startedAt),
        );
        span.end();
      }
    },
  );
}

function setCapturedAttribute(span: Span, key: string, value: unknown): void {
  const captured = captureTraceValue(value);
  span.setAttribute(key, captured.value);
  span.setAttribute(`${key}.original_bytes`, captured.originalBytes);
  span.setAttribute(`${key}.sha256`, captured.sha256);
  span.setAttribute(`${key}.truncated`, captured.truncated);
}

function recordSafeFailure(
  span: Span,
  error: unknown,
  publicMessage: string,
): void {
  const failure = captureTraceValue(
    {
      error:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    },
    { redactKeys: ["error"] },
  );
  span.setAttribute("appkit.error", failure.value);
  span.setAttribute("mlflow.spanOutputs", failure.value);
  span.setAttribute("mlflow.spanOutputs.original_bytes", failure.originalBytes);
  span.setAttribute("mlflow.spanOutputs.sha256", failure.sha256);
  span.setAttribute("mlflow.spanOutputs.truncated", failure.truncated);
  span.recordException({ name: "Error", message: publicMessage });
  span.setStatus({ code: SpanStatusCode.ERROR, message: publicMessage });
}

/**
 * In-memory thread store backed by a nested Map.
 *
 * Outer key: userId, inner key: threadId. Thread history is retained for the
 * lifetime of the process with no eviction, caps, or TTL — a chatty user will
 * grow the in-memory footprint monotonically, and the server loses every
 * thread on restart. **This implementation is intended for local development
 * and single-process demos only.**
 *
 * For any real deployment, pass a persistent `ThreadStore` to `agents({ ... })`
 * (e.g. a Lakebase- or Postgres-backed implementation). A bounded
 * `InMemoryThreadStore` with eviction policies is tracked as a follow-up.
 */
export class InMemoryThreadStore implements ThreadStore {
  private store = new Map<string, Map<string, Thread>>();

  async create(userId: string): Promise<Thread> {
    const now = new Date();
    const thread: Thread = {
      id: randomUUID(),
      userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.userMap(userId).set(thread.id, thread);
    return thread;
  }

  async get(threadId: string, userId: string): Promise<Thread | null> {
    return this.userMap(userId).get(threadId) ?? null;
  }

  async list(userId: string): Promise<Thread[]> {
    return Array.from(this.userMap(userId).values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async addMessage(
    threadId: string,
    userId: string,
    message: Message,
  ): Promise<void> {
    const thread = this.userMap(userId).get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    thread.messages.push(message);
    thread.updatedAt = new Date();
  }

  async delete(threadId: string, userId: string): Promise<boolean> {
    return this.userMap(userId).delete(threadId);
  }

  private userMap(userId: string): Map<string, Thread> {
    let map = this.store.get(userId);
    if (!map) {
      map = new Map();
      this.store.set(userId, map);
    }
    return map;
  }
}

/**
 * Semantic tracing decorator for any {@link ThreadStore} implementation.
 *
 * The wrapped store remains the source of truth; this class only adds MEMORY
 * descendants using AppKit's active OpenTelemetry provider and central value
 * capture policy.
 */
export class TracedThreadStore implements ThreadStore {
  constructor(private readonly backing: ThreadStore) {}

  create(userId: string): Promise<Thread> {
    return traceMemoryOperation("create", userId, { userId }, async (span) => {
      const thread = await this.backing.create(userId);
      span.setAttribute("appkit.memory.state", "created");
      return thread;
    });
  }

  get(threadId: string, userId: string): Promise<Thread | null> {
    return traceMemoryOperation(
      "get",
      threadId,
      { threadId, userId },
      async (span) => {
        const thread = await this.backing.get(threadId, userId);
        span.setAttribute("appkit.memory.state", thread ? "hit" : "miss");
        return thread;
      },
    );
  }

  list(userId: string): Promise<Thread[]> {
    return traceMemoryOperation("list", userId, { userId }, async (span) => {
      const threads = await this.backing.list(userId);
      span.setAttribute("appkit.memory.state", "completed");
      return threads;
    });
  }

  addMessage(
    threadId: string,
    userId: string,
    message: Message,
  ): Promise<void> {
    return traceMemoryOperation(
      "addMessage",
      threadId,
      { message, threadId, userId },
      async (span) => {
        await this.backing.addMessage(threadId, userId, message);
        span.setAttribute("appkit.memory.state", "completed");
      },
    );
  }

  delete(threadId: string, userId: string): Promise<boolean> {
    return traceMemoryOperation(
      "delete",
      threadId,
      { threadId, userId },
      async (span) => {
        const deleted = await this.backing.delete(threadId, userId);
        span.setAttribute("appkit.memory.state", deleted ? "deleted" : "miss");
        return deleted;
      },
    );
  }
}
