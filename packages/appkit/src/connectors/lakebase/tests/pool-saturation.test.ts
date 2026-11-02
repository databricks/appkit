import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_POOL_MAX,
  LAKEBASE_MIN_CONNECTION_LIMIT,
  watchPoolSaturation,
} from "../pool-saturation";

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
}

describe("watchPoolSaturation", () => {
  let pool: FakePool;
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    logger.warn.mockClear();
    pool = new FakePool();
    watchPoolSaturation(pool as unknown as Pool, {
      name: "SP",
      max: 105,
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("defaults the pool to the smallest compute's connection limit", () => {
    expect(LAKEBASE_MIN_CONNECTION_LIMIT).toBe(105);
    expect(DEFAULT_POOL_MAX).toBe(LAKEBASE_MIN_CONNECTION_LIMIT);
  });

  test("stays quiet when nobody is waiting", () => {
    pool.totalCount = 10;
    pool.emit("acquire");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("warns with pool usage when callers are queued", () => {
    pool.totalCount = 105;
    pool.idleCount = 0;
    pool.waitingCount = 4;
    pool.emit("acquire");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("saturated"),
      "SP",
      105,
      105,
      4,
    );
  });

  test("throttles repeated warnings to one per minute", () => {
    pool.waitingCount = 1;
    pool.emit("acquire");
    pool.emit("acquire");
    vi.advanceTimersByTime(59_000);
    pool.emit("acquire");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    pool.emit("acquire");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
