import { mockServiceContext } from "@tools/test-helpers";
import { sql } from "shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { QueryProcessor } from "../query";

describe("QueryProcessor", () => {
  const processor = new QueryProcessor();
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext({
      workspaceId: "1234567890",
    });
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  describe("convertToSQLParameters - Parameter Injection Protection", () => {
    test("should accept valid parameters that exist in query", () => {
      const query = "SELECT * FROM users WHERE id = :user_id AND name = :name";
      const parameters = {
        user_id: sql.number(123),
        name: sql.string("Alice"),
      };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.statement).toBe(query);
      expect(result.parameters).toHaveLength(2);
      expect(result.parameters).toEqual([
        { name: "user_id", value: "123", type: "INT" },
        { name: "name", value: "Alice", type: "STRING" },
      ]);
    });

    test("should reject parameters that do not exist in query", () => {
      const query = "SELECT * FROM users WHERE id = :user_id";
      const parameters = {
        user_id: sql.number(123),
        malicious_param: sql.string("DROP TABLE"),
      };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow(
        "Invalid value for malicious_param: expected a parameter defined in the query (valid: user_id)",
      );
    });

    test("should reject multiple invalid parameters", () => {
      const query = "SELECT * FROM users WHERE id = :user_id";
      const parameters = {
        user_id: sql.number(123),
        admin_flag: sql.boolean(true),
        delete_all: sql.boolean(true),
      };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow("Invalid value for admin_flag");
    });

    test("should allow parameters with underscores and mixed case", () => {
      const query =
        "SELECT * FROM orders WHERE customer_id = :customer_id AND order_Date = :order_Date";
      const parameters = {
        customer_id: sql.number(456),
        order_Date: sql.date("2024-01-01"),
      };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters).toHaveLength(2);
      expect(result.parameters[0].name).toBe("customer_id");
      expect(result.parameters[1].name).toBe("order_Date");
    });

    test("should handle query with no parameters", () => {
      const query = "SELECT * FROM users";
      const parameters = { user_id: sql.number(123) };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow(
        "Invalid value for user_id: expected a parameter defined in the query (valid: none)",
      );
    });

    test("should accept empty parameters object for query with no params", () => {
      const query = "SELECT * FROM users";
      const parameters = {};

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.statement).toBe(query);
      expect(result.parameters).toHaveLength(0);
    });

    test("should accept undefined parameters", () => {
      const query = "SELECT * FROM users WHERE id = :user_id";

      const result = processor.convertToSQLParameters(query, undefined);

      expect(result.statement).toBe(query);
      expect(result.parameters).toHaveLength(0);
    });

    test("should handle parameters with null/undefined values (filtered out)", () => {
      const query =
        "SELECT * FROM users WHERE id = :user_id AND status = :status";
      const parameters = { user_id: sql.number(123), status: null };

      const result = processor.convertToSQLParameters(query, parameters);

      // null values are filtered out by _createParameter
      expect(result.parameters).toHaveLength(1);
      expect(result.parameters[0].name).toBe("user_id");
    });

    test("should protect against parameter injection in realistic attack scenario", () => {
      const query =
        "SELECT * FROM orders WHERE customer_id = :customer_id AND status = :status";
      const attackParameters = {
        customer_id: sql.number(123),
        status: sql.string("pending"),
        // Attack: try to inject additional parameters
        admin_override: sql.boolean(true),
        bypass_auth: sql.string("true"),
        internal_flag: sql.number(1),
      };

      expect(() => {
        processor.convertToSQLParameters(query, attackParameters);
      }).toThrow("Invalid value for admin_override");
    });

    test("should handle duplicate parameter names in query correctly", () => {
      const query =
        "SELECT * FROM users WHERE (status = :status OR backup_status = :status)";
      const parameters = { status: sql.string("active") };

      const result = processor.convertToSQLParameters(query, parameters);

      // Should only create one parameter even if it appears multiple times in query
      expect(result.parameters).toHaveLength(1);
      expect(result.parameters[0].name).toBe("status");
    });
  });

  describe("processQueryParams", () => {
    test("should auto-inject workspace_id when needed and not provided", async () => {
      const query = "SELECT * FROM data WHERE workspace_id = :workspaceId";
      const parameters = {};

      // ServiceContext is already mocked with workspaceId: "1234567890" in beforeEach
      const result = await processor.processQueryParams(query, parameters);

      expect(result.workspaceId).toEqual({
        __sql_type: "STRING",
        value: "1234567890",
      });
    });

    test("should not override workspace_id if already provided", async () => {
      const query = "SELECT * FROM data WHERE workspace_id = :workspaceId";
      // 9876543210 exceeds INT_MAX (2^31 - 1) so inference falls through to
      // BIGINT — appropriate for ID columns.
      const parameters = { workspaceId: sql.number("9876543210") };

      const result = await processor.processQueryParams(query, parameters);

      expect(result.workspaceId).toEqual({
        __sql_type: "BIGINT",
        value: "9876543210",
      });
    });
  });

  describe("LIMIT / OFFSET bindings (regression for #323)", () => {
    // Spark requires IntegerType for LIMIT/OFFSET; BIGINT/LongType is
    // rejected with INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE. These tests
    // pin INT inference so sql.number(req.query.n) works against the
    // warehouse without explicit casting.
    //
    // These tests are MOCKED — they assert the wire-type string the
    // helper emits, not warehouse round-trip behaviour. To re-validate
    // that the mocked assertions still match production Spark semantics:
    //
    //   1. Pick any RUNNING SQL Warehouse you can reach
    //      (`databricks warehouses list -p <profile>` and grep for RUNNING).
    //   2. POST /api/2.0/sql/statements with the helper's wire-type strings
    //      directly, using the same VALUES-based query so no table is
    //      required:
    //
    //      databricks api post /api/2.0/sql/statements --json '{
    //        "statement": "SELECT x FROM (VALUES (1),(2),(3),(4),(5)) AS t(x) ORDER BY x LIMIT :n OFFSET :m",
    //        "warehouse_id": "<id>",
    //        "wait_timeout": "30s",
    //        "parameters": [
    //          {"name": "n", "value": "2", "type": "INT"},
    //          {"name": "m", "value": "1", "type": "INT"}
    //        ]
    //      }'
    //
    //   3. Expect: `status.state == "SUCCEEDED"`, `result.row_count == 2`.
    //   4. Swap both parameter `type` values to `"BIGINT"` and re-run.
    //      Expect: `status.state == "FAILED"`, error message
    //      `[INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE] ... must be integer
    //      type, but got "BIGINT". SQLSTATE: 42K0E`.
    //
    //   If (3) fails or (4) starts succeeding, Spark's LIMIT type contract
    //   has changed and the INT-by-default inference should be re-evaluated.
    test("sql.number(integer) binds as INT for LIMIT/OFFSET", () => {
      const query = "SELECT * FROM events LIMIT :n OFFSET :m";
      const parameters = {
        n: sql.number(10),
        m: sql.number(20),
      };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters).toEqual([
        { name: "n", value: "10", type: "INT" },
        { name: "m", value: "20", type: "INT" },
      ]);
    });

    test("sql.number(integer-shaped string) binds as INT for LIMIT/OFFSET", () => {
      // Express/URLSearchParams return strings — this is the common
      // handler pattern: sql.number(req.query.n).
      const query = "SELECT * FROM events LIMIT :n OFFSET :m";
      const parameters = {
        n: sql.number("10"),
        m: sql.number("20"),
      };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters).toEqual([
        { name: "n", value: "10", type: "INT" },
        { name: "m", value: "20", type: "INT" },
      ]);
    });

    test("sql.int(string) binds as INT for LIMIT/OFFSET (explicit form)", () => {
      const query = "SELECT * FROM events LIMIT :n";
      const parameters = { n: sql.int("10") };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters).toEqual([
        { name: "n", value: "10", type: "INT" },
      ]);
    });
  });

  describe("_createParameter - Type Handling", () => {
    test("should handle date parameters with sql.date()", () => {
      const query = "SELECT * FROM events WHERE event_date = :startDate";
      const parameters = { startDate: sql.date("2024-01-01") };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "startDate",
        value: "2024-01-01",
        type: "DATE",
      });
    });

    test("should handle timestamp parameters with sql.timestamp()", () => {
      const query = "SELECT * FROM events WHERE created_at = :createdTime";
      const parameters = {
        createdTime: sql.timestamp(new Date("2024-01-01T12:00:00Z")),
      };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "createdTime",
        value: "2024-01-01T12:00:00Z",
        type: "TIMESTAMP",
      });
    });

    test("should handle boolean parameters with sql.boolean()", () => {
      const query = "SELECT * FROM users WHERE is_active = :isActive";
      const parameters = { isActive: sql.boolean(true) };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "isActive",
        value: "true",
        type: "BOOLEAN",
      });
    });

    test("should handle numeric parameters with sql.number()", () => {
      const query = "SELECT * FROM users WHERE age = :age";
      const parameters = { age: sql.number(25) };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "age",
        value: "25",
        type: "INT",
      });
    });

    test("should handle string parameters with sql.string()", () => {
      const query = "SELECT * FROM metrics WHERE level = :aggregationLevel";
      const parameters = { aggregationLevel: sql.string("day") };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "aggregationLevel",
        value: "day",
        type: "STRING",
      });
    });

    test("should reject non-SQL type parameters", () => {
      const query = "SELECT * FROM users WHERE id = :userId";
      const parameters = { userId: 123 as any };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow("Invalid value for userId");
    });
  });
});
