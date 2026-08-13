import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import type { CacheEntry, CacheStorage } from "shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CacheManager } from "../../cache";
import { createApp } from "../appkit";

class LifecyclePersistentStorage implements CacheStorage {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private ended = false;

  private assertOpen(): void {
    if (this.ended) throw new Error("persistent pool has ended");
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.assertOpen();
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.assertOpen();
    this.entries.set(key, entry as CacheEntry<unknown>);
  }

  async delete(key: string): Promise<void> {
    this.assertOpen();
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.assertOpen();
    this.entries.clear();
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    return this.entries.has(key);
  }

  async size(): Promise<number> {
    this.assertOpen();
    return this.entries.size;
  }

  isPersistent(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    this.assertOpen();
    return true;
  }

  async close(): Promise<void> {
    if (this.ended) throw new Error("persistent pool ended twice");
    this.ended = true;
  }
}

let serviceContext: Awaited<ReturnType<typeof mockServiceContext>>;

beforeEach(async () => {
  setupDatabricksEnv();
  serviceContext = await mockServiceContext();
});

afterEach(async () => {
  serviceContext.restore();
});

test("two sequential app lifecycles recreate persistent cache storage", async () => {
  const baselineSigterm = process.listenerCount("SIGTERM");
  const baselineSigint = process.listenerCount("SIGINT");
  const firstStorage = new LifecyclePersistentStorage();
  const first = await createApp({
    plugins: [],
    cache: { storage: firstStorage },
    disableInternalTelemetry: true,
  });
  await CacheManager.getInstanceSync().set("first", "value");
  await first.shutdown();

  const secondStorage = new LifecyclePersistentStorage();
  const second = await createApp({
    plugins: [],
    cache: { storage: secondStorage },
    disableInternalTelemetry: true,
  });
  await CacheManager.getInstanceSync().set("second", "value");
  expect(await CacheManager.getInstanceSync().get("second")).toBe("value");
  await second.shutdown();

  expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
  expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
});
