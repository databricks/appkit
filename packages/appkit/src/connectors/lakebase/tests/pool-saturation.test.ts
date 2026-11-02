import { EventEmitter } from "node:events";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createPoolSaturationWatch } from "../pool-saturation";

/** A pg client that connects on the next tick and never opens a socket. */
class MemoryClient extends EventEmitter {
  /** pg-pool keeps a released client idle only when the driver reports it queryable. */
  _queryable = true;
  connect(callback: (error?: Error) => void) {
    process.nextTick(callback);
  }
  end(callback?: () => void) {
    this.emit("end");
    callback?.();
  }
}

const HINT = "Raise it.";

describe("createPoolSaturationWatch", () => {
  const logger = { warn: vi.fn() };
  const pools: pg.Pool[] = [];

  function memoryPool(options: {
    max: number;
    connectionTimeoutMillis?: number;
  }) {
    const pool = new pg.Pool({
      ...options,
      Client: MemoryClient as unknown as pg.PoolConfig["Client"],
    });
    pools.push(pool);
    return pool;
  }

  function source(max: number) {
    return createPoolSaturationWatch({ name: "SP", max, hint: HINT, logger });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await Promise.all(
      pools
        .splice(0)
        .filter((pool) => !pool.ending)
        .map((pool) => pool.end()),
    );
    vi.useRealTimers();
  });

  test("warns once when a single caller queues on a full pool", async () => {
    const pool = memoryPool({ max: 1 });
    source(1)(pool);
    const held = await pool.connect();

    const queued = pool.connect();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/saturated[\s\S]*%s$/),
      "SP",
      1,
      1,
      HINT,
    );
    held.release();
    (await queued).release();
  });

  test("warns when two callers race for the one idle client of a warmed pool", async () => {
    const pool = memoryPool({ max: 1 });
    source(1)(pool);
    (await pool.connect()).release();

    const served = pool.connect();
    const queued = pool.connect();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/saturated/),
      "SP",
      1,
      1,
      HINT,
    );
    (await served).release();
    (await queued).release();
  });

  test("warns while callers time out behind a held client", async () => {
    const pool = memoryPool({ max: 1, connectionTimeoutMillis: 50 });
    source(1)(pool);
    const held = await pool.connect();

    const outcomes = Promise.allSettled([pool.connect(), pool.connect()]);
    await vi.advanceTimersByTimeAsync(50);

    expect((await outcomes).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    held.release();
  });

  test("stays quiet when a checkout is rejected because the pool is ending", async () => {
    const pool = memoryPool({ max: 1 });
    source(1)(pool);
    const held = await pool.connect();
    void pool.connect();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);

    const ended = pool.end();
    await expect(pool.connect()).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    held.release();
    await ended;
  });

  test("stays quiet when concurrent checkouts find idle clients", async () => {
    const pool = memoryPool({ max: 2 });
    source(2)(pool);
    const first = await Promise.all([pool.connect(), pool.connect()]);
    for (const client of first) client.release();

    const second = await Promise.all([pool.connect(), pool.connect()]);

    expect(logger.warn).not.toHaveBeenCalled();
    for (const client of second) client.release();
  });

  test("shares one warning per minute across the pools of a source", async () => {
    const watch = source(1);
    const first = memoryPool({ max: 1 });
    const second = memoryPool({ max: 1 });
    watch(first);
    watch(second);
    const heldFirst = await first.connect();
    const heldSecond = await second.connect();

    const queuedFirst = first.connect();
    const queuedSecond = second.connect();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    heldFirst.release();
    const servedFirst = await queuedFirst;
    const queuedAgain = first.connect();
    expect(logger.warn).toHaveBeenCalledTimes(2);

    servedFirst.release();
    (await queuedAgain).release();
    heldSecond.release();
    (await queuedSecond).release();
  });
});
