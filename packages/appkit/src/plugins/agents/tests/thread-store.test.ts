import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Message, Thread, ThreadStore } from "shared";
import { describe, expect, test, vi } from "vitest";
import { AgentsPlugin } from "../agents";
import { InMemoryThreadStore } from "../thread-store";

async function captureSpans(
  operation: () => Promise<unknown>,
): Promise<{ spans: ReadableSpan[]; error?: unknown }> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const getTracerSpy = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name: string, version?: string) =>
      provider.getTracer(name, version),
    );
  let error: unknown;
  let spans: ReadableSpan[] = [];
  try {
    await operation();
  } catch (caught) {
    error = caught;
  } finally {
    await provider.forceFlush();
    spans = exporter.getFinishedSpans();
    getTracerSpy.mockRestore();
    await provider.shutdown();
  }
  return { spans, ...(error !== undefined ? { error } : {}) };
}

function configuredStore(backing?: ThreadStore): ThreadStore {
  const plugin = new AgentsPlugin({
    dir: false,
    ...(backing ? { threadStore: backing } : {}),
  });
  return (plugin as unknown as { threadStore: ThreadStore }).threadStore;
}

function memorySpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(
    (span) => span.attributes["mlflow.spanType"] === "MEMORY",
  );
}

describe("InMemoryThreadStore", () => {
  test("create() returns a new thread with the given userId", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");

    expect(thread.id).toBeDefined();
    expect(thread.userId).toBe("user-1");
    expect(thread.messages).toEqual([]);
    expect(thread.createdAt).toBeInstanceOf(Date);
    expect(thread.updatedAt).toBeInstanceOf(Date);
  });

  test("get() returns the thread for the correct user", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");

    const retrieved = await store.get(thread.id, "user-1");
    expect(retrieved).toEqual(thread);
  });

  test("get() returns null for wrong user", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");

    const retrieved = await store.get(thread.id, "user-2");
    expect(retrieved).toBeNull();
  });

  test("get() returns null for non-existent thread", async () => {
    const store = new InMemoryThreadStore();
    const retrieved = await store.get("non-existent", "user-1");
    expect(retrieved).toBeNull();
  });

  test("list() returns threads sorted by updatedAt desc", async () => {
    const store = new InMemoryThreadStore();
    const t1 = await store.create("user-1");
    const t2 = await store.create("user-1");

    // Make t1 more recently updated
    await store.addMessage(t1.id, "user-1", {
      id: "msg-1",
      role: "user",
      content: "hello",
      createdAt: new Date(),
    });

    const threads = await store.list("user-1");
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe(t1.id);
    expect(threads[1].id).toBe(t2.id);
  });

  test("list() returns empty for unknown user", async () => {
    const store = new InMemoryThreadStore();
    await store.create("user-1");

    const threads = await store.list("user-2");
    expect(threads).toEqual([]);
  });

  test("addMessage() appends to thread and updates timestamp", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");
    const originalUpdatedAt = thread.updatedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    await store.addMessage(thread.id, "user-1", {
      id: "msg-1",
      role: "user",
      content: "hello",
      createdAt: new Date(),
    });

    const updated = await store.get(thread.id, "user-1");
    expect(updated?.messages).toHaveLength(1);
    expect(updated?.messages[0].content).toBe("hello");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  test("addMessage() throws for non-existent thread", async () => {
    const store = new InMemoryThreadStore();

    await expect(
      store.addMessage("non-existent", "user-1", {
        id: "msg-1",
        role: "user",
        content: "hello",
        createdAt: new Date(),
      }),
    ).rejects.toThrow("Thread non-existent not found");
  });

  test("delete() removes a thread and returns true", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");

    const deleted = await store.delete(thread.id, "user-1");
    expect(deleted).toBe(true);

    const retrieved = await store.get(thread.id, "user-1");
    expect(retrieved).toBeNull();
  });

  test("delete() returns false for non-existent thread", async () => {
    const store = new InMemoryThreadStore();
    const deleted = await store.delete("non-existent", "user-1");
    expect(deleted).toBe(false);
  });

  test("delete() returns false for wrong user", async () => {
    const store = new InMemoryThreadStore();
    const thread = await store.create("user-1");

    const deleted = await store.delete(thread.id, "user-2");
    expect(deleted).toBe(false);
  });

  test("threads are isolated per user", async () => {
    const store = new InMemoryThreadStore();
    await store.create("user-1");
    await store.create("user-1");
    await store.create("user-2");

    const user1Threads = await store.list("user-1");
    const user2Threads = await store.list("user-2");

    expect(user1Threads).toHaveLength(2);
    expect(user2Threads).toHaveLength(1);
  });
});

describe("TracedThreadStore", () => {
  test("wraps configured stores and traces create, get hit/miss, list, add, and delete", async () => {
    const store = configuredStore(new InMemoryThreadStore());
    let created: Thread | undefined;
    let hit: Thread | null = null;
    let miss: Thread | null = null;
    let listed: Thread[] = [];
    let deleted = false;
    const message: Message = {
      id: "message-1",
      role: "user",
      content: "remember this complete message",
      createdAt: new Date("2026-08-11T12:00:00.000Z"),
    };

    const observed = await captureSpans(async () => {
      created = await store.create("user-7");
      hit = await store.get(created.id, "user-7");
      miss = await store.get("thread-missing", "user-7");
      listed = await store.list("user-7");
      await store.addMessage(created.id, "user-7", message);
      deleted = await store.delete(created.id, "user-7");
    });

    expect(observed.error).toBeUndefined();
    expect((hit as Thread | null)?.id).toBe(created?.id);
    expect(miss).toBeNull();
    expect(listed).toHaveLength(1);
    expect(deleted).toBe(true);
    const spans = memorySpans(observed.spans);
    expect(spans).toHaveLength(6);
    expect(
      spans.map((span) => [
        span.attributes["appkit.memory.operation"],
        span.attributes["appkit.memory.state"],
        span.attributes["appkit.memory.store"],
        span.attributes["appkit.memory.key"],
      ]),
    ).toEqual([
      ["create", "created", "thread", "user-7"],
      ["get", "hit", "thread", created?.id],
      ["get", "miss", "thread", "thread-missing"],
      ["list", "completed", "thread", "user-7"],
      ["addMessage", "completed", "thread", created?.id],
      ["delete", "deleted", "thread", created?.id],
    ]);
    expect(
      spans.every(
        (span) =>
          span.status.code === SpanStatusCode.OK &&
          typeof span.attributes["appkit.memory.duration_ms"] === "number",
      ),
    ).toBe(true);
    expect(
      JSON.parse(String(spans[1].attributes["mlflow.spanInputs"])),
    ).toEqual({
      threadId: created?.id,
      userId: "user-7",
    });
    expect(
      JSON.parse(String(spans[2].attributes["mlflow.spanOutputs"])),
    ).toBeNull();
    expect(
      JSON.parse(String(spans[4].attributes["mlflow.spanInputs"])),
    ).toEqual({
      message: {
        content: "remember this complete message",
        createdAt: "2026-08-11T12:00:00.000Z",
        id: "message-1",
        role: "user",
      },
      threadId: created?.id,
      userId: "user-7",
    });
    expect(JSON.parse(String(spans[5].attributes["mlflow.spanOutputs"]))).toBe(
      true,
    );
  });

  test("wraps the default store before any route can use it", async () => {
    const store = configuredStore();
    const observed = await captureSpans(() => store.create("default-user"));

    expect(observed.error).toBeUndefined();
    expect(memorySpans(observed.spans)).toHaveLength(1);
    expect(
      memorySpans(observed.spans)[0].attributes["appkit.memory.operation"],
    ).toBe("create");
  });

  test("records backing-store failures without logging their secret detail", async () => {
    const backing: ThreadStore = {
      create: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw new Error("postgres password super-secret-value");
      },
      list: async () => [],
      addMessage: async () => {},
      delete: async () => false,
    };
    const store = configuredStore(backing);

    const observed = await captureSpans(() => store.get("thread-7", "user-7"));

    expect(observed.error).toEqual(
      new Error("postgres password super-secret-value"),
    );
    const [span] = memorySpans(observed.spans);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      "appkit.memory.operation": "get",
      "appkit.memory.state": "failed",
      "appkit.error": '{"error":"[REDACTED]"}',
      "appkit.memory.duration_ms": expect.any(Number),
    });
    expect(
      JSON.stringify({ attributes: span.attributes, events: span.events }),
    ).not.toContain("super-secret-value");
  });

  test("applies central redaction and truncation to message and thread values", async () => {
    const secretThread = {
      id: "thread-secret",
      userId: "user-secret",
      messages: [],
      createdAt: new Date("2026-08-11T12:00:00.000Z"),
      updatedAt: new Date("2026-08-11T12:00:00.000Z"),
      user: { secret: "private-user-value" },
      thread: { secret: "private-thread-value" },
    } as Thread;
    const backing: ThreadStore = {
      create: async () => secretThread,
      get: async () => secretThread,
      list: async () => [secretThread],
      addMessage: async () => {},
      delete: async () => true,
    };
    const store = configuredStore(backing);

    const observed = await captureSpans(async () => {
      await store.get("thread-secret", "user-secret");
      await store.addMessage("thread-secret", "user-secret", {
        id: "long-message",
        role: "user",
        content: "x".repeat(70 * 1024),
        createdAt: new Date("2026-08-11T12:00:00.000Z"),
      });
    });

    expect(observed.error).toBeUndefined();
    const [getSpan, addSpan] = memorySpans(observed.spans);
    expect(JSON.stringify(getSpan.attributes)).not.toContain(
      "private-user-value",
    );
    expect(JSON.stringify(getSpan.attributes)).not.toContain(
      "private-thread-value",
    );
    expect(String(getSpan.attributes["mlflow.spanOutputs"])).toContain(
      '"secret":"[REDACTED]"',
    );
    expect(addSpan.attributes["mlflow.spanInputs.truncated"]).toBe(true);
    expect(
      addSpan.attributes["mlflow.spanInputs.original_bytes"],
    ).toBeGreaterThan(64 * 1024);
    expect(
      Buffer.byteLength(String(addSpan.attributes["mlflow.spanInputs"])),
    ).toBeLessThanOrEqual(64 * 1024);
  });
});
