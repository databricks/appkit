import { describe, expect, test } from "vitest";

import {
  classifyDatabaseError,
  DatabasePluginError,
  databaseSetupFailed,
} from "../errors";

describe("database setup diagnostics", () => {
  test("keeps the default failure stable when no diagnostic is supplied", () => {
    expect(databaseSetupFailed()).toMatchObject({
      category: "SETUP_FAILED",
      phase: "setup",
      statusCode: 500,
      message: "Database setup failed",
      clientMessage: "Database setup failed",
    });
  });

  test("gives the server an actionable diagnostic without exposing it to clients", () => {
    const error = databaseSetupFailed(
      'Unknown option "api.write". Use api.writes.',
    );
    expect(error.message).toBe(
      'Database setup failed: Unknown option "api.write". Use api.writes.',
    );
    expect(error.clientMessage).toBe("Database setup failed");
    expect(error.details).toBeUndefined();
  });

  test.each(["read", "write", "transaction"] as const)(
    "strips setup diagnostics at the %s boundary",
    (phase) => {
      const error = classifyDatabaseError(
        databaseSetupFailed('Table "_events" cannot be exposed through api.'),
        phase,
      );
      expect(error).toMatchObject({
        category: "SETUP_FAILED",
        phase,
        message: "Database setup failed",
        clientMessage: "Database setup failed",
        cause: undefined,
        details: undefined,
      });
    },
  );

  test("does not allow request diagnostics to replace the stable message", () => {
    const error = new DatabasePluginError(
      "INTERNAL",
      "read",
      "internal detail",
    );
    expect(error.message).toBe("Database operation failed");
    expect(error.clientMessage).toBe("Database operation failed");
  });
});
