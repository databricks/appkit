import { describe, expect, test } from "vitest";
import {
  assertReadOnlySql,
  classifyReadOnly,
  ReadOnlySqlViolation,
} from "../tools/sql-policy";

function ok(sql: string) {
  const result = classifyReadOnly(sql);
  if (!result.readOnly) {
    throw new Error(
      `Expected readOnly=true for ${JSON.stringify(sql)}, got reason: ${result.reason}`,
    );
  }
  return result;
}

function rejected(sql: string) {
  const result = classifyReadOnly(sql);
  if (result.readOnly) {
    throw new Error(
      `Expected readOnly=false for ${JSON.stringify(sql)}, got readOnly=true`,
    );
  }
  return result;
}

describe("classifyReadOnly: plain reads are admitted", () => {
  test.each([
    "SELECT 1",
    "select 1",
    "SELECT * FROM users",
    "SELECT * FROM main.sales.orders WHERE created_at > now() - interval '7 days'",
    "SELECT COUNT(*) FROM main.sales.orders",
    "WITH a AS (SELECT 1) SELECT * FROM a",
    "WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t",
    "SHOW TABLES",
    "SHOW TABLES IN main.sales",
    "DESCRIBE EXTENDED main.sales.orders",
    "DESC main.sales.orders",
    "EXPLAIN SELECT 1",
    "EXPLAIN ANALYZE SELECT 1",
  ])("admits %s", (sql) => {
    expect(ok(sql).statements).toBe(1);
  });
});

describe("classifyReadOnly: writes are rejected", () => {
  test.each([
    ["DROP TABLE users", "DROP"],
    ["UPDATE users SET email = 'x@y.com'", "UPDATE"],
    ["DELETE FROM orders WHERE id = 1", "DELETE"],
    ["INSERT INTO x VALUES (1)", "INSERT"],
    ["CREATE TABLE x (id INT)", "CREATE"],
    ["ALTER TABLE x ADD COLUMN y INT", "ALTER"],
    ["TRUNCATE TABLE orders", "TRUNCATE"],
    ["GRANT SELECT ON t TO u", "GRANT"],
    ["REVOKE ALL ON t FROM u", "REVOKE"],
    ["CALL sp_do_thing()", "CALL"],
    ["COPY t FROM '/tmp/x'", "COPY"],
    ["MERGE INTO t USING s", "MERGE"],
    ["REFRESH TABLE t", "REFRESH"],
    ["VACUUM t", "VACUUM"],
  ])("rejects %s", (sql, keyword) => {
    const result = rejected(sql);
    expect(result.reason).toContain(keyword);
  });
});

describe("classifyReadOnly: stacked statements", () => {
  test("rejects SELECT followed by DROP", () => {
    const result = rejected("SELECT 1; DROP TABLE x");
    expect(result.reason).toMatch(/DROP/);
  });

  test("rejects DROP followed by SELECT (write comes first)", () => {
    const result = rejected("DROP TABLE x; SELECT 1");
    expect(result.reason).toMatch(/DROP/);
  });

  test("admits multiple SELECTs", () => {
    expect(ok("SELECT 1; SELECT 2").statements).toBe(2);
  });

  test("admits trailing semicolon on single statement", () => {
    expect(ok("SELECT 1;").statements).toBe(1);
  });

  test("admits SELECT, SHOW, DESCRIBE batch", () => {
    const result = ok("SELECT 1; SHOW TABLES; DESCRIBE x;");
    expect(result.statements).toBe(3);
  });
});

describe("classifyReadOnly: comment handling", () => {
  test("admits SELECT with line comment hiding a write keyword", () => {
    ok("SELECT 1 -- DROP TABLE x\n");
  });

  test("admits SELECT preceded by line comment with write keyword", () => {
    ok("-- DROP TABLE x\nSELECT 1");
  });

  test("admits SELECT with block comment containing stacked write", () => {
    ok("SELECT 1 /* ; DROP TABLE x */");
  });

  test("handles nested block comments (PostgreSQL style)", () => {
    ok("SELECT 1 /* outer /* inner */ still inside */");
  });

  test("rejects when write is outside the comment", () => {
    const result = rejected("/* SELECT 1 */ DROP TABLE x");
    expect(result.reason).toMatch(/DROP/);
  });

  test("empty after stripping comments is rejected", () => {
    rejected("-- only a comment");
    rejected("/* nothing */");
  });
});

describe("classifyReadOnly: string literal handling", () => {
  test("admits SELECT with write keyword inside single-quoted string", () => {
    ok("SELECT 'DROP TABLE x' AS msg");
  });

  test("admits SELECT with semicolon inside single-quoted string", () => {
    ok("SELECT 'value; DROP TABLE x' AS msg");
  });

  test("admits SELECT with doubled-quote escape", () => {
    ok("SELECT 'it''s ok; DROP' AS msg");
  });

  test("admits SELECT with backslash escape inside string", () => {
    ok("SELECT E'line\\'s end; DROP' AS msg");
  });

  test("admits SELECT with dollar-quoted string hiding a write", () => {
    ok("SELECT $body$ arbitrary ; DROP TABLE x $body$ AS msg");
  });

  test("admits SELECT with untagged dollar quote", () => {
    ok("SELECT $$hello; DROP$$ AS msg");
  });

  test("admits SELECT with ANSI double-quoted identifier named drop", () => {
    ok('SELECT * FROM "drop"');
  });

  test("admits SELECT with doubled-quote inside ANSI identifier", () => {
    ok('SELECT * FROM "weird""name"');
  });

  test("admits SELECT with backtick identifier (Databricks)", () => {
    ok("SELECT * FROM `my table`");
  });
});

describe("classifyReadOnly: degenerate input", () => {
  test("rejects empty string", () => {
    rejected("");
  });

  test("rejects whitespace-only", () => {
    rejected("   \n\t  ");
  });

  test("rejects semicolons only", () => {
    rejected(";;;");
  });

  test("rejects non-SQL garbage", () => {
    rejected("-- this is just a comment\n-- nothing else");
    rejected("random garbage text");
  });

  test("rejects a single empty statement between two selects", () => {
    // "SELECT 1;; SELECT 2" — the middle empty statement is dropped by
    // splitter; the surviving two statements are both SELECT, admitted.
    ok("SELECT 1;; SELECT 2");
  });
});

describe("classifyReadOnly: evasion-resistance", () => {
  test("cannot hide DROP after a comment-ended newline", () => {
    const result = rejected("-- intent\nDROP TABLE x");
    expect(result.reason).toMatch(/DROP/);
  });

  test("cannot hide DROP via concatenated strings (strings end cleanly)", () => {
    rejected("'SELECT 1'; DROP TABLE x");
  });

  test("bare DROP after unclosed string is still considered part of the string (defensive)", () => {
    // An unclosed single quote eats the rest of the input — classifier
    // sees the whole thing as one stripped, empty-ish statement and rejects.
    rejected("SELECT 'unterminated ; DROP TABLE x");
  });

  test("dollar-quoted literal with malicious tag is handled", () => {
    ok("SELECT $tag$ DROP $tag$ AS harmless");
  });

  test("mismatched dollar-quote tag is treated as unterminated", () => {
    rejected("SELECT $a$ DROP TABLE x $b$");
  });
});

describe("assertReadOnlySql", () => {
  test("returns void on read-only SQL", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
  });

  test("throws ReadOnlySqlViolation with descriptive message on writes", () => {
    expect(() => assertReadOnlySql("DROP TABLE x")).toThrow(
      ReadOnlySqlViolation,
    );
    try {
      assertReadOnlySql("DROP TABLE x");
    } catch (e) {
      expect((e as Error).message).toMatch(/SQL read-only policy violation/);
      expect((e as Error).message).toMatch(/DROP/);
    }
  });
});
