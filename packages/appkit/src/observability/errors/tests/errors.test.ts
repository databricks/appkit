import { describe, expect, test } from "vitest";
import {
  AppKitError,
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  ExecutionError,
  InitializationError,
  ServerError,
  TunnelError,
  ValidationError,
} from "../index";

describe("AppKitError base class", () => {
  test("should be an instance of Error", () => {
    const error = new ValidationError("test");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppKitError);
  });

  test("should have correct name property", () => {
    const error = new ValidationError("test");
    expect(error.name).toBe("ValidationError");
  });

  test("should preserve cause", () => {
    const cause = new Error("original error");
    const error = new ValidationError("wrapped error", { cause });
    expect(error.cause).toBe(cause);
    expect(error.cause?.message).toBe("original error");
  });

  test("should preserve context", () => {
    const error = new ValidationError("test", {
      context: { field: "email", value: "invalid" },
    });
    expect(error.context).toEqual({ field: "email", value: "invalid" });
  });

  test("toJSON should return serializable object", () => {
    const cause = new Error("cause");
    const error = new ValidationError("test message", {
      cause,
      context: { field: "value" },
    });
    const json = error.toJSON();
    expect(json.name).toBe("ValidationError");
    expect(json.code).toBe("VALIDATION_ERROR");
    expect(json.message).toBe("test message");
    expect(json.statusCode).toBe(400);
    expect(json.isRetryable).toBe(false);
    expect(json.context).toEqual({ field: "value" });
    expect(json.cause).toBe("cause");
    expect(json.stack).toBeDefined();
  });

  test("toJSON should redact sensitive fields in context", () => {
    const error = new ValidationError("test", {
      context: {
        userToken: "secret-token-123",
        password: "my-password",
        apiKey: "api-key-value",
        normalField: "visible",
      },
    });
    const json = error.toJSON();
    const context = json.context as Record<string, unknown>;
    expect(context.userToken).toBe("[REDACTED]");
    expect(context.password).toBe("[REDACTED]");
    expect(context.apiKey).toBe("[REDACTED]");
    expect(context.normalField).toBe("visible");
  });

  test("toJSON should handle nested objects in context", () => {
    const error = new ValidationError("test", {
      context: {
        config: { nested: "object" },
        items: [1, 2, 3],
      },
    });
    const json = error.toJSON();
    const context = json.context as Record<string, unknown>;
    expect(context.config).toBe("[Object]");
    expect(context.items).toBe("[Array(3)]");
  });

  test("toString should return formatted string", () => {
    const error = new ValidationError("field is invalid");
    expect(error.toString()).toBe(
      "ValidationError [VALIDATION_ERROR]: field is invalid",
    );
  });

  test("toString should include cause", () => {
    const cause = new Error("root cause");
    const error = new ValidationError("field is invalid", { cause });
    expect(error.toString()).toContain("caused by: root cause");
  });
});

describe("ValidationError", () => {
  test("should have correct code and statusCode", () => {
    const error = new ValidationError("test");
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.statusCode).toBe(400);
    expect(error.isRetryable).toBe(false);
  });

  test("missingField should create proper error", () => {
    const error = ValidationError.missingField("username");
    expect(error.message).toBe("Missing required field: username");
    expect(error.context?.field).toBe("username");
  });

  test("invalidValue should create proper error", () => {
    const error = ValidationError.invalidValue("age", -5, "positive number");
    expect(error.message).toBe(
      "Invalid value for age: expected positive number",
    );
    expect(error.context?.field).toBe("age");
    expect(error.context?.valueType).toBe("number");
    expect(error.context?.expected).toBe("positive number");
  });

  test("invalidValue should not store raw value for security", () => {
    const error = ValidationError.invalidValue("token", "secret-token-123");
    expect(error.context?.value).toBeUndefined();
    expect(error.context?.valueType).toBe("string");
  });

  test("invalidValue should handle null values", () => {
    const error = ValidationError.invalidValue("field", null);
    expect(error.context?.valueType).toBe("null");
  });

  test("missingEnvVars should create proper error", () => {
    const error = ValidationError.missingEnvVars(["API_KEY", "SECRET"]);
    expect(error.message).toBe(
      "Missing required environment variables: API_KEY, SECRET",
    );
    expect(error.context?.missingVars).toEqual(["API_KEY", "SECRET"]);
  });
});

describe("AuthenticationError", () => {
  test("should have correct code and statusCode", () => {
    const error = new AuthenticationError("test");
    expect(error.code).toBe("AUTHENTICATION_ERROR");
    expect(error.statusCode).toBe(401);
    expect(error.isRetryable).toBe(false);
  });

  test("missingToken should create proper error", () => {
    const error = AuthenticationError.missingToken("bearer token");
    expect(error.message).toBe("Missing bearer token in request headers");
    expect(error.context?.tokenType).toBe("bearer token");
  });

  test("missingUserId should create proper error", () => {
    const error = AuthenticationError.missingUserId();
    expect(error.message).toContain("User ID not available");
  });

  test("credentialsFailed should create proper error with cause", () => {
    const cause = new Error("network timeout");
    const error = AuthenticationError.credentialsFailed("my-instance", cause);
    expect(error.message).toContain("my-instance");
    expect(error.cause).toBe(cause);
    expect(error.context?.instance).toBe("my-instance");
  });

  test("userLookupFailed should create proper error", () => {
    const error = AuthenticationError.userLookupFailed();
    expect(error.message).toContain("Failed to get current user");
  });
});

describe("ConfigurationError", () => {
  test("should have correct code and statusCode", () => {
    const error = new ConfigurationError("test");
    expect(error.code).toBe("CONFIGURATION_ERROR");
    expect(error.statusCode).toBe(500);
    expect(error.isRetryable).toBe(false);
  });

  test("missingEnvVar should create proper error", () => {
    const error = ConfigurationError.missingEnvVar("DATABASE_URL");
    expect(error.message).toBe("DATABASE_URL environment variable is required");
    expect(error.context?.envVar).toBe("DATABASE_URL");
  });

  test("resourceNotFound should create proper error with hint", () => {
    const error = ConfigurationError.resourceNotFound(
      "Warehouse ID",
      "Set DATABRICKS_WAREHOUSE_ID",
    );
    expect(error.message).toBe(
      "Warehouse ID not found. Set DATABRICKS_WAREHOUSE_ID",
    );
    expect(error.context?.resource).toBe("Warehouse ID");
  });

  test("invalidConnection should create proper error", () => {
    const error = ConfigurationError.invalidConnection(
      "PostgreSQL",
      "Check env vars",
    );
    expect(error.message).toBe(
      "PostgreSQL connection not configured. Check env vars",
    );
    expect(error.context?.service).toBe("PostgreSQL");
  });

  test("missingConnectionParam should create proper error", () => {
    const error = ConfigurationError.missingConnectionParam("appName");
    expect(error.message).toBe(
      "Connection string must include appName parameter",
    );
    expect(error.context?.parameter).toBe("appName");
  });
});

describe("ConnectionError", () => {
  test("should have correct code and statusCode", () => {
    const error = new ConnectionError("test");
    expect(error.code).toBe("CONNECTION_ERROR");
    expect(error.statusCode).toBe(503);
    expect(error.isRetryable).toBe(true);
  });

  test("queryFailed should create proper error", () => {
    const cause = new Error("timeout");
    const error = ConnectionError.queryFailed(cause);
    expect(error.message).toBe("Query failed");
    expect(error.cause).toBe(cause);
  });

  test("transactionFailed should create proper error", () => {
    const error = ConnectionError.transactionFailed();
    expect(error.message).toBe("Transaction failed");
  });

  test("poolError should create proper error", () => {
    const error = ConnectionError.poolError("closing connection");
    expect(error.message).toBe("Connection pool error: closing connection");
  });

  test("apiFailure should create proper error", () => {
    const error = ConnectionError.apiFailure("SQL Warehouse");
    expect(error.message).toBe("No response received from SQL Warehouse API");
    expect(error.context?.service).toBe("SQL Warehouse");
  });

  test("clientUnavailable should create proper error with hint", () => {
    const error = ConnectionError.clientUnavailable(
      "Databricks client",
      "Initialize ServiceContext first",
    );
    expect(error.message).toBe(
      "Databricks client not available. Initialize ServiceContext first",
    );
    expect(error.context?.clientType).toBe("Databricks client");
  });
});

describe("ExecutionError", () => {
  test("should have correct code and statusCode", () => {
    const error = new ExecutionError("test");
    expect(error.code).toBe("EXECUTION_ERROR");
    expect(error.statusCode).toBe(500);
    expect(error.isRetryable).toBe(false);
  });

  test("statementFailed should create proper error", () => {
    const error = ExecutionError.statementFailed("syntax error near SELECT");
    expect(error.message).toBe("Statement failed: syntax error near SELECT");
  });

  test("statementFailed should handle undefined message", () => {
    const error = ExecutionError.statementFailed();
    expect(error.message).toBe("Statement failed: Unknown error");
  });

  test("canceled should create proper error", () => {
    const error = ExecutionError.canceled();
    expect(error.message).toBe("Statement was canceled");
  });

  test("resultsClosed should create proper error", () => {
    const error = ExecutionError.resultsClosed();
    expect(error.message).toContain("no longer available");
    expect(error.message).toContain("CLOSED state");
  });

  test("unknownState should create proper error", () => {
    const error = ExecutionError.unknownState("WEIRD_STATE");
    expect(error.message).toBe("Unknown statement state: WEIRD_STATE");
    expect(error.context?.state).toBe("WEIRD_STATE");
  });

  test("missingData should create proper error", () => {
    const error = ExecutionError.missingData("chunks or schema");
    expect(error.message).toBe("No chunks or schema found in response");
    expect(error.context?.dataType).toBe("chunks or schema");
  });
});

describe("InitializationError", () => {
  test("should have correct code and statusCode", () => {
    const error = new InitializationError("test");
    expect(error.code).toBe("INITIALIZATION_ERROR");
    expect(error.statusCode).toBe(500);
    expect(error.isRetryable).toBe(true);
  });

  test("notInitialized should create proper error with hint", () => {
    const error = InitializationError.notInitialized(
      "CacheManager",
      "Call AppKit.create() first",
    );
    expect(error.message).toBe(
      "CacheManager not initialized. Call AppKit.create() first",
    );
    expect(error.context?.service).toBe("CacheManager");
  });

  test("setupFailed should create proper error with cause", () => {
    const cause = new Error("connection refused");
    const error = InitializationError.setupFailed("persistent storage", cause);
    expect(error.message).toBe("Failed to initialize persistent storage");
    expect(error.cause).toBe(cause);
    expect(error.context?.component).toBe("persistent storage");
  });

  test("migrationFailed should create proper error", () => {
    const cause = new Error("table already exists");
    const error = InitializationError.migrationFailed(cause);
    expect(error.message).toContain("migrations");
    expect(error.cause).toBe(cause);
  });
});

describe("ServerError", () => {
  test("should have correct code and statusCode", () => {
    const error = new ServerError("test");
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.statusCode).toBe(500);
    expect(error.isRetryable).toBe(false);
  });

  test("autoStartConflict should create proper error", () => {
    const error = ServerError.autoStartConflict("get server");
    expect(error.message).toBe("Cannot get server when autoStart is true");
    expect(error.context?.operation).toBe("get server");
  });

  test("notStarted should create proper error", () => {
    const error = ServerError.notStarted();
    expect(error.message).toContain("Server not started");
    expect(error.message).toContain("start()");
  });

  test("viteNotInitialized should create proper error", () => {
    const error = ServerError.viteNotInitialized();
    expect(error.message).toBe("Vite dev server not initialized");
  });

  test("clientDirectoryNotFound should create proper error", () => {
    const error = ServerError.clientDirectoryNotFound(["client", "src", "."]);
    expect(error.message).toContain("Could not find client directory");
    expect(error.message).toContain("client, src, .");
    expect(error.context?.searchedPaths).toEqual(["client", "src", "."]);
  });
});

describe("TunnelError", () => {
  test("should have correct code and statusCode", () => {
    const error = new TunnelError("test");
    expect(error.code).toBe("TUNNEL_ERROR");
    expect(error.statusCode).toBe(502);
    expect(error.isRetryable).toBe(true);
  });

  test("getterNotRegistered should create proper error", () => {
    const error = TunnelError.getterNotRegistered();
    expect(error.message).toContain("Tunnel getter not registered");
  });

  test("noConnection should create proper error", () => {
    const error = TunnelError.noConnection();
    expect(error.message).toContain("No tunnel connection available");
  });

  test("fetchFailed should create proper error with path", () => {
    const cause = new Error("timeout");
    const error = TunnelError.fetchFailed("/assets/main.js", cause);
    expect(error.message).toBe("Failed to fetch asset");
    expect(error.cause).toBe(cause);
    expect(error.context?.path).toBe("/assets/main.js");
  });

  test("parseError should create proper error", () => {
    const cause = new SyntaxError("Unexpected token");
    const error = TunnelError.parseError("WebSocket", cause);
    expect(error.message).toBe("Failed to parse WebSocket message");
    expect(error.cause).toBe(cause);
    expect(error.context?.messageType).toBe("WebSocket");
  });
});

describe("Error hierarchy", () => {
  test("all errors should extend AppKitError", () => {
    expect(new ValidationError("test")).toBeInstanceOf(AppKitError);
    expect(new AuthenticationError("test")).toBeInstanceOf(AppKitError);
    expect(new ConfigurationError("test")).toBeInstanceOf(AppKitError);
    expect(new ConnectionError("test")).toBeInstanceOf(AppKitError);
    expect(new ExecutionError("test")).toBeInstanceOf(AppKitError);
    expect(new InitializationError("test")).toBeInstanceOf(AppKitError);
    expect(new ServerError("test")).toBeInstanceOf(AppKitError);
    expect(new TunnelError("test")).toBeInstanceOf(AppKitError);
  });

  test("errors can be caught by base class", () => {
    try {
      throw new ValidationError("test");
    } catch (e) {
      expect(e).toBeInstanceOf(AppKitError);
    }
  });

  test("errors can be distinguished by code", () => {
    const errors = [
      new ValidationError("test"),
      new AuthenticationError("test"),
      new ConfigurationError("test"),
      new ConnectionError("test"),
      new ExecutionError("test"),
      new InitializationError("test"),
      new ServerError("test"),
      new TunnelError("test"),
    ];

    const codes = errors.map((e) => e.code);
    expect(codes).toEqual([
      "VALIDATION_ERROR",
      "AUTHENTICATION_ERROR",
      "CONFIGURATION_ERROR",
      "CONNECTION_ERROR",
      "EXECUTION_ERROR",
      "INITIALIZATION_ERROR",
      "SERVER_ERROR",
      "TUNNEL_ERROR",
    ]);
  });

  test("retryable errors should be marked correctly", () => {
    // These errors are generally transient and can be retried
    expect(new ConnectionError("test").isRetryable).toBe(true);
    expect(new InitializationError("test").isRetryable).toBe(true);
    expect(new TunnelError("test").isRetryable).toBe(true);

    // These errors require fixing, not retrying
    expect(new ValidationError("test").isRetryable).toBe(false);
    expect(new AuthenticationError("test").isRetryable).toBe(false);
    expect(new ConfigurationError("test").isRetryable).toBe(false);
    expect(new ExecutionError("test").isRetryable).toBe(false);
    expect(new ServerError("test").isRetryable).toBe(false);
  });

  test("isRetryable can guide retry logic", () => {
    const errors: AppKitError[] = [
      new ConnectionError("temporary network issue"),
      new ValidationError("invalid input"),
      new TunnelError("tunnel disconnected"),
    ];

    const retryable = errors.filter((e) => e.isRetryable);
    expect(retryable).toHaveLength(2);
    expect(retryable[0]).toBeInstanceOf(ConnectionError);
    expect(retryable[1]).toBeInstanceOf(TunnelError);
  });
});
