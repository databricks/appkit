import { describe, expect, test } from "vitest";
import { QueryProcessor } from "../src/query";

describe("QueryProcessor", () => {
  const processor = new QueryProcessor();

  describe("convertToSQLParameters - Parameter Injection Protection", () => {
    test("should accept valid parameters that exist in query", () => {
      const query = "SELECT * FROM users WHERE id = :user_id AND name = :name";
      const parameters = { user_id: 123, name: "Alice" };

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
      const parameters = { user_id: 123, malicious_param: "DROP TABLE" };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow(
        'Parameter "malicious_param" not found in query. Valid parameters: user_id',
      );
    });

    test("should reject multiple invalid parameters", () => {
      const query = "SELECT * FROM users WHERE id = :user_id";
      const parameters = {
        user_id: 123,
        admin_flag: true,
        delete_all: true,
      };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow('Parameter "admin_flag" not found in query');
    });

    test("should allow parameters with underscores and mixed case", () => {
      const query =
        "SELECT * FROM orders WHERE customer_id = :customer_id AND order_Date = :order_Date";
      const parameters = { customer_id: 456, order_Date: "2024-01-01" };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters).toHaveLength(2);
      expect(result.parameters[0].name).toBe("customer_id");
      expect(result.parameters[1].name).toBe("order_Date");
    });

    test("should handle query with no parameters", () => {
      const query = "SELECT * FROM users";
      const parameters = { user_id: 123 };

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
      const parameters = { user_id: 123, status: null };

      const result = processor.convertToSQLParameters(query, parameters);

      // null values are filtered out by _createParameter
      expect(result.parameters).toHaveLength(1);
      expect(result.parameters[0].name).toBe("user_id");
    });

    test("should protect against parameter injection in realistic attack scenario", () => {
      const query =
        "SELECT * FROM orders WHERE customer_id = :customer_id AND status = :status";
      const attackParameters = {
        customer_id: 123,
        status: "pending",
        // Attack: try to inject additional parameters
        admin_override: true,
        bypass_auth: "true",
        internal_flag: 1,
      };

      expect(() => {
        processor.convertToSQLParameters(query, attackParameters);
      }).toThrow('Parameter "admin_override" not found in query');
    });

    test("should handle duplicate parameter names in query correctly", () => {
      const query =
        "SELECT * FROM users WHERE (status = :status OR backup_status = :status)";
      const parameters = { status: "active" };

      const result = processor.convertToSQLParameters(query, parameters);

      // Should only create one parameter even if it appears multiple times in query
      expect(result.parameters).toHaveLength(1);
      expect(result.parameters[0].name).toBe("status");
    });
  });

  describe("processQueryParams", () => {
    test("should auto-inject workspace_id when needed and not provided", () => {
      const originalEnv = process.env.DATABRICKS_WORKSPACE_ID;
      process.env.DATABRICKS_WORKSPACE_ID = "workspace-123";

      const query = "SELECT * FROM data WHERE workspace_id = :workspace_id";
      const parameters = {};

      const result = processor.processQueryParams(query, parameters);

      expect(result.workspace_id).toBe("workspace-123");

      process.env.DATABRICKS_WORKSPACE_ID = originalEnv;
    });

    test("should not override workspace_id if already provided", () => {
      const originalEnv = process.env.DATABRICKS_WORKSPACE_ID;
      process.env.DATABRICKS_WORKSPACE_ID = "workspace-123";

      const query = "SELECT * FROM data WHERE workspace_id = :workspace_id";
      const parameters = { workspace_id: "custom-workspace" };

      const result = processor.processQueryParams(query, parameters);

      expect(result.workspace_id).toBe("custom-workspace");

      process.env.DATABRICKS_WORKSPACE_ID = originalEnv;
    });
  });

  describe("_createParameter - Type Handling", () => {
    test("should handle date parameters", () => {
      const query = "SELECT * FROM events WHERE event_date = :startDate";
      const parameters = { startDate: "2024-01-01" };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "startDate",
        value: "2024-01-01",
        type: "DATE",
      });
    });

    test("should reject invalid date format", () => {
      const query = "SELECT * FROM events WHERE event_date = :startDate";
      const parameters = { startDate: "01/01/2024" };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow("Invalid date format for parameter startDate: 01/01/2024");
    });

    test("should handle timestamp parameters", () => {
      const query = "SELECT * FROM events WHERE created_at = :createdTime";
      const date = new Date("2024-01-01T12:00:00Z");
      const parameters = { createdTime: date };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "createdTime",
        value: date.toISOString(),
        type: "TIMESTAMP",
      });
    });

    test("should handle boolean parameters", () => {
      const query = "SELECT * FROM users WHERE is_active = :isActive";
      const parameters = { isActive: true };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "isActive",
        value: "true",
        type: "BOOLEAN",
      });
    });

    test("should handle numeric parameters", () => {
      const query = "SELECT * FROM users WHERE age = :age";
      const parameters = { age: 25 };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "age",
        value: "25",
        type: "NUMERIC",
      });
    });

    test("should validate aggregationLevel parameter", () => {
      const query = "SELECT * FROM metrics WHERE level = :aggregationLevel";
      const parameters = { aggregationLevel: "day" };

      const result = processor.convertToSQLParameters(query, parameters);

      expect(result.parameters[0]).toEqual({
        name: "aggregationLevel",
        value: "day",
        type: "STRING",
      });
    });

    test("should reject invalid aggregationLevel", () => {
      const query = "SELECT * FROM metrics WHERE level = :aggregationLevel";
      const parameters = { aggregationLevel: "invalid" };

      expect(() => {
        processor.convertToSQLParameters(query, parameters);
      }).toThrow(
        "Invalid aggregation level: invalid. Must be one of: hour, day, week, month, year",
      );
    });
  });
});
