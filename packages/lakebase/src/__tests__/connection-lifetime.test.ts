import pg from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createLakebasePool } from "../pool";
import type { LakebasePoolConfig, Logger } from "../types";

// Why connections need a lifetime. Lakebase checks a token only at login and
// rejects expired ones, so a token is at most an hour old when a connection
// opens. An open connection keeps working after that, but access granted
// through Unity Catalog claims in the token stops working 4 hours after the
// token was minted (measured on a live endpoint: every read on the old
// connections then fails with 42501 while the connections stay up). So every
// connection has to close before its token is 4 hours old:
//
//   token age at login (≤ 1 h) + connection lifetime < 4 h − margin
//
// The margin covers a connection checked out past its lifetime (pg-pool only
// recycles idle clients), login time and clock skew. A lifetime within
// MAX_SAFE_LIFETIME_MS is safe whatever token the cache hands out.
const HOUR_MS = 60 * 60_000;
const TOKEN_LIFETIME_MS = HOUR_MS;
const CLAIMS_LAPSE_MS = 4 * HOUR_MS;
const SAFETY_MARGIN_MS = HOUR_MS / 2;
const MAX_SAFE_LIFETIME_MS =
  CLAIMS_LAPSE_MS - TOKEN_LIFETIME_MS - SAFETY_MARGIN_MS;

// config.ts falls back to these (PGPORT and PGSSLMODE are read only from the
// environment), so clear them to keep a developer's shell from changing the
// result.
const ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGSSLMODE",
  "LAKEBASE_ENDPOINT",
  "DATABRICKS_CLIENT_ID",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

const pools: pg.Pool[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

// Real factory and pg.Pool, so `pool.options` shows what reached pg.
// Construction is lazy, so no connection is opened.
function makePool(config: Partial<LakebasePoolConfig> = {}): pg.Pool {
  const pool = createLakebasePool({
    host: "ep-test.database.us-east-1.databricks.com",
    database: "databricks_postgres",
    user: "test-user@example.com",
    password: "test-only",
    ...config,
  });
  pools.push(pool);
  return pool;
}

/** The lifetime that reached pg.Pool; pg-pool treats 0 as "never recycle". */
function lifetimeMs(pool: pg.Pool): number {
  return (pool.options.maxLifetimeSeconds ?? 0) * 1000;
}

describe("connection lifetime", () => {
  test("recycles connections by default, early enough that claims never lapse", () => {
    const pool = makePool();

    // The exact default is the owners' call; it only has to be safe for a
    // connection that logs in with a nearly expired token.
    expect(lifetimeMs(pool)).toBeGreaterThan(0);
    expect(lifetimeMs(pool)).toBeLessThanOrEqual(MAX_SAFE_LIFETIME_MS);
  });
});

describe("connection lifetime warnings", () => {
  function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  // Policy check: an explicit 0 is a deliberate opt-out, so it's kept, but it
  // should never be silent.
  test("keeps an explicit lifetime of 0 and warns that connections are never recycled", () => {
    const logger = makeLogger();
    const pool = makePool({ maxLifetimeSeconds: 0, logger });

    expect(lifetimeMs(pool)).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  // pg-pool would close every connection as soon as it opens for a negative
  // lifetime, and never recycle for NaN (it turns NaN into 0), so these must
  // not reach pg.Pool. Above 2^31 - 1 ms, Node's setTimeout fires after 1 ms,
  // so pg-pool would close every connection after one use.
  test.each([
    ["negative", -5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["past Node's timer limit", 2_147_484],
    ["just past Node's timer limit, fractionally", 2_147_483.7],
    ["30 days", 30 * 24 * 60 * 60],
  ])(
    "uses the default lifetime and warns when the lifetime is %s",
    (_name, value) => {
      const logger = makeLogger();
      const pool = makePool({ maxLifetimeSeconds: value, logger });

      expect(lifetimeMs(pool)).toBe(lifetimeMs(makePool()));
      expect(logger.warn).toHaveBeenCalled();
    },
  );

  // The longest whole-second lifetime Node's timer can hold is still valid:
  // it's kept (with the too-long warning), not replaced by the default.
  test("keeps the longest lifetime Node's timer can hold", () => {
    const logger = makeLogger();
    const pool = makePool({ maxLifetimeSeconds: 2_147_483, logger });

    expect(pool.options.maxLifetimeSeconds).toBe(2_147_483);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("warns when the lifetime is too long to recycle connections before claims lapse", () => {
    const logger = makeLogger();
    makePool({ maxLifetimeSeconds: MAX_SAFE_LIFETIME_MS / 1000 + 1, logger });

    expect(logger.warn).toHaveBeenCalled();
  });

  test("doesn't warn for the default lifetime or a safe one", () => {
    const logger = makeLogger();
    makePool({ logger });
    makePool({ maxLifetimeSeconds: 30 * 60, logger });
    // Still safe, so a warning here would be noise. This pins the threshold to
    // the claims lapse, not to the token's 1-hour expiry.
    makePool({ maxLifetimeSeconds: 2 * 60 * 60, logger });
    makePool({ maxLifetimeSeconds: MAX_SAFE_LIFETIME_MS / 1000, logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
