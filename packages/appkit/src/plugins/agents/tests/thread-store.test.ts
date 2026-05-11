import { describe, expect, test } from "vitest";
import { InMemoryThreadStore } from "../thread-store";

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
