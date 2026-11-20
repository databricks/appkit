import pg from "pg";
import { describe, expect, test } from "vitest";

import { createLakebasePool } from "../pool";

// Use the real factory and pg.Pool. Construction is lazy, so these tests never
// open a connection or request credentials.
describe("PostgreSQL pool timeouts", () => {
  test.each([
    ["unspecified", undefined, undefined],
    ["disabled", 0, 0],
    ["configured", 30_000, 15_000],
  ] as const)(
    "preserves %s timeouts in pg.Pool",
    async (_name, statementTimeout, idleTimeout) => {
      const pool = createLakebasePool({
        host: "localhost",
        database: "test",
        user: "test",
        password: "test-only",
        sslMode: "disable",
        statement_timeout: statementTimeout,
        idle_in_transaction_session_timeout: idleTimeout,
      });
      try {
        expect(pool).toBeInstanceOf(pg.Pool);
        expect(pool.options.statement_timeout).toBe(statementTimeout);
        expect(pool.options.idle_in_transaction_session_timeout).toBe(
          idleTimeout,
        );
        expect(pool.totalCount).toBe(0);
      } finally {
        await pool.end();
      }
    },
  );
});

// LakebasePoolConfig extends pg's PoolConfig, so these options always
// type-check. These tests catch getLakebasePgConfig() copying only a fixed list
// of keys and silently dropping the rest.
describe("PostgreSQL pool option pass-through", () => {
  test.each([
    ["application_name", "my-lakebase-app"],
    ["keepAlive", true],
    ["query_timeout", 15_000],
    ["options", "-c search_path=app"],
    ["maxLifetimeSeconds", 900],
  ] as const)("passes %s through to pg.Pool", async (key, value) => {
    const pool = createLakebasePool({
      host: "localhost",
      database: "test",
      user: "test",
      password: "test-only",
      sslMode: "disable",
      [key]: value,
    });
    try {
      expect(pool.options[key]).toEqual(value);
    } finally {
      await pool.end();
    }
  });
});
