import { runWithRequestContext } from "@tools/test-helpers";
import { sql } from "shared";
import { describe, expect, test } from "vitest";
import { QueryProcessor } from "../query";

describe("QueryProcessor", () => {
  const processor = new QueryProcessor();

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
        { name: "user_id", value: "123", type: "NUMERIC" },
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
        'Parameter "malicious_param" not found in query. Valid parameters: user_id',
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
      }).toThrow('Parameter "admin_flag" not found in query');
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
        'Parameter "user_id" not found in query. Valid parameters: none',
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
      }).toThrow('Parameter "admin_override" not found in query');
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

      const result = await runWithRequestContext(
        async () => {
          return await processor.processQueryParams(query, parameters);
        },
        {
          workspaceId: Promise.resolve("1234567890"),
        },
      );

      expect(result.workspaceId).toEqual({
        __sql_type: "STRING",
        value: "1234567890",
      });
    });

    test("should not override workspace_id if already provided", async () => {
      const query = "SELECT * FROM data WHERE workspace_id = :workspaceId";
      const parameters = { workspaceId: sql.number("9876543210") };

      const result = await runWithRequestContext(
        async () => {
          return await processor.processQueryParams(query, parameters);
        },
        {
          workspaceId: Promise.resolve("1234567890"),
        },
      );

      expect(result.workspaceId).toEqual({
        __sql_type: "NUMERIC",
        value: "9876543210",
      });
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
        type: "NUMERIC",
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
      }).toThrow(
        'Parameter "userId" must be a SQL type. Use sql.string(), sql.number(), sql.date(), sql.timestamp(), or sql.boolean().',
      );
    });
  });
});
