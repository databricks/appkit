import { randomUUID } from "node:crypto";
import type { Message, Thread, ThreadStore } from "shared";

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
