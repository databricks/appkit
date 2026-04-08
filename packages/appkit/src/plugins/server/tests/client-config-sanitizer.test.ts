import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../logging/logger", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { sanitizeClientConfig } from "../client-config-sanitizer";

describe("sanitizeClientConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("passes through config whose values don't match any env var", () => {
    process.env.DATABRICKS_HOST = "https://my-workspace.databricks.com";
    process.env.MY_CUSTOM_VAR = "some-value";

    const config = { greeting: "hello", count: 42 };
    expect(sanitizeClientConfig("test", config)).toEqual(config);
  });

  test("redacts any non-public env var value found in the config", () => {
    process.env.DATABRICKS_HOST = "https://secret.databricks.com";
    process.env.MY_API_KEY = "sk-abc-123";

    const config = {
      host: "https://secret.databricks.com",
      apiKey: "sk-abc-123",
      safe: "no-leak-here",
    };

    const result = sanitizeClientConfig("leaky-plugin", config);

    expect(result.host).toBe("[redacted by appkit]");
    expect(result.apiKey).toBe("[redacted by appkit]");
    expect(result.safe).toBe("no-leak-here");
  });

  test("redacts deeply nested leaked values", () => {
    process.env.DATABRICKS_HOST = "https://nested.databricks.com";

    const config = {
      outer: {
        inner: {
          url: "https://nested.databricks.com",
        },
      },
    };

    const result = sanitizeClientConfig("test", config) as any;
    expect(result.outer.inner.url).toBe("[redacted by appkit]");
  });

  test("allows PUBLIC_APPKIT_ env var values to pass through", () => {
    process.env.PUBLIC_APPKIT_THEME = "dark";
    process.env.DATABRICKS_TOKEN = "secret";

    const config = {
      theme: "dark",
      token: "secret",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.theme).toBe("dark");
    expect(result.token).toBe("[redacted by appkit]");
  });

  test("redacts env vars regardless of prefix", () => {
    process.env.OTEL_ENDPOINT = "https://otel.internal";
    process.env.FLASK_RUN_HOST = "0.0.0.0";
    process.env.CUSTOM_SECRET = "my-secret-value";

    const config = {
      otelUrl: "https://otel.internal",
      host: "0.0.0.0",
      secret: "my-secret-value",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.otelUrl).toBe("[redacted by appkit]");
    expect(result.host).toBe("[redacted by appkit]");
    expect(result.secret).toBe("[redacted by appkit]");
  });

  test("redacts values wrapped with JSON.stringify", () => {
    process.env.DATABRICKS_HOST = "https://secret.databricks.com";

    const config = {
      host: JSON.stringify("https://secret.databricks.com"),
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.host).toBe("[redacted by appkit]");
  });

  test("redacts values embedded via string concatenation", () => {
    process.env.DATABRICKS_TOKEN = "dapi-secret-token-123";

    const config = {
      auth: "Bearer " + "dapi-secret-token-123",
      url: "https://host/" + "dapi-secret-token-123" + "/path",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.auth).toBe("[redacted by appkit]");
    expect(result.url).toBe("[redacted by appkit]");
  });

  test("redacts values embedded via template literals", () => {
    process.env.MY_SECRET = "super-secret-value";

    const secret = "super-secret-value";
    const config = {
      message: `The secret is ${secret}`,
      wrapped: `[${secret}]`,
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.message).toBe("[redacted by appkit]");
    expect(result.wrapped).toBe("[redacted by appkit]");
  });

  test("redacts deeply nested embedded values", () => {
    process.env.DATABRICKS_HOST = "https://nested.databricks.com";

    const config = {
      outer: {
        inner: {
          url: `https://nested.databricks.com/api/v1`,
        },
        list: [`Host: https://nested.databricks.com`, "safe-value"],
      },
    };

    const result = sanitizeClientConfig("test", config) as any;
    expect(result.outer.inner.url).toBe("[redacted by appkit]");
    expect(result.outer.list[0]).toBe("[redacted by appkit]");
    expect(result.outer.list[1]).toBe("safe-value");
  });

  test("does not false-positive on short env values as substrings", () => {
    process.env.SHORT_VAR = "ab";
    process.env.TINY = "x";

    const config = {
      text: "The alphabet starts with ab and x marks the spot",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.text).toBe(
      "The alphabet starts with ab and x marks the spot",
    );
  });

  test("still catches short env values on exact match", () => {
    process.env.SHORT_VAR = "ab";

    const config = { value: "ab" };
    const result = sanitizeClientConfig("test", config);
    expect(result.value).toBe("[redacted by appkit]");
  });

  test("does not redact public values whose text overlaps a non-public value", () => {
    process.env.DATABRICKS_HOST = "internal.acme.example.com";
    process.env.PUBLIC_APPKIT_DATABRICKS_HOST = "ext-internal.acme.example.com";

    const config = {
      host: "ext-internal.acme.example.com",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.host).toBe("ext-internal.acme.example.com");
  });

  test("still redacts non-public value even when a public value overlaps", () => {
    process.env.DATABRICKS_HOST = "internal.acme.example.com";
    process.env.PUBLIC_APPKIT_DATABRICKS_HOST = "ext-internal.acme.example.com";

    const config = {
      host: "internal.acme.example.com",
      embedded: "Bearer internal.acme.example.com/api",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.host).toBe("[redacted by appkit]");
    expect(result.embedded).toBe("[redacted by appkit]");
  });

  test("does not redact when public and non-public vars share the same value", () => {
    process.env.DATABRICKS_HOST = "shared.acme.example.com";
    process.env.PUBLIC_APPKIT_DATABRICKS_HOST = "shared.acme.example.com";

    const config = {
      host: "shared.acme.example.com",
      wrapped: JSON.stringify("shared.acme.example.com"),
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.host).toBe("shared.acme.example.com");
    expect(result.wrapped).toBe('"shared.acme.example.com"');
  });

  test("redacts leaked values even when an overlapping public value is also present", () => {
    process.env.DATABRICKS_HOST = "internal.acme.example.com";
    process.env.PUBLIC_APPKIT_DATABRICKS_HOST = "ext-internal.acme.example.com";

    const config = {
      mixed:
        "public=ext-internal.acme.example.com private=internal.acme.example.com",
    };

    const result = sanitizeClientConfig("test", config);
    expect(result.mixed).toBe("[redacted by appkit]");
  });

  test("redacts longer secrets even when a public value overlaps as a substring", () => {
    process.env.PUBLIC_APPKIT_LABEL = "abc";
    process.env.SECRET_LABEL = "abc123";

    const result = sanitizeClientConfig("test", {
      token: "Bearer abc123",
    });

    expect(result.token).toBe("[redacted by appkit]");
  });

  test("redacts env-derived object keys", () => {
    process.env.DATABRICKS_TOKEN = "secret-token";

    const result = sanitizeClientConfig("test", {
      "secret-token": true,
    });

    expect(result).toEqual({
      "[redacted by appkit]": true,
    });
  });

  test("keeps redacted object keys unique when multiple keys leak", () => {
    process.env.DATABRICKS_TOKEN = "secret-token";

    const result = sanitizeClientConfig("test", {
      "prefix-secret-token": true,
      "secret-token-suffix": false,
    });

    expect(result).toEqual({
      "[redacted by appkit]": true,
      "[redacted by appkit] (2)": false,
    });
  });

  test("throws on non-serializable bigint values", () => {
    expect(() => sanitizeClientConfig("test", { count: BigInt(1) })).toThrow(
      /BigInt/,
    );
  });

  test("throws on circular references", () => {
    const config: Record<string, unknown> = {};
    config.self = config;

    expect(() => sanitizeClientConfig("test", config)).toThrow(/circular/);
  });

  test("throws on circular arrays", () => {
    const config: Array<unknown> = [];
    config.push(config);

    expect(() => sanitizeClientConfig("test", { items: config })).toThrow(
      /circular/,
    );
  });

  test("rejects reserved object keys like __proto__", () => {
    const config = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(() => sanitizeClientConfig("test", config)).toThrow(/reserved key/);
  });

  test("omits undefined object fields and normalizes undefined array items", () => {
    const result = sanitizeClientConfig("test", {
      present: "value",
      missing: undefined,
      items: ["a", undefined, "b"],
    });

    expect(result).toEqual({
      present: "value",
      items: ["a", null, "b"],
    });
  });
});
