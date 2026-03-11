import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../errors";
import { createEnv } from "../create-env";

describe("createEnv", () => {
  it("validates and returns typed env values", () => {
    const env = createEnv({
      server: z.object({
        HOST: z.string(),
        PORT: z.coerce.number(),
      }),
      client: z.object({
        VITE_TITLE: z.string(),
      }),
      runtimeEnv: {
        HOST: "https://example.com",
        PORT: "3000",
        VITE_TITLE: "My App",
      },
    });

    expect(env.HOST).toBe("https://example.com");
    expect(env.PORT).toBe(3000);
    expect(env.VITE_TITLE).toBe("My App");
  });

  it("applies default values for missing optional vars", () => {
    const env = createEnv({
      server: z.object({
        NODE_ENV: z
          .enum(["development", "production", "test"])
          .default("production"),
      }),
      client: z.object({
        VITE_APP_NAME: z.string().default("Untitled"),
      }),
      runtimeEnv: {},
    });

    expect(env.NODE_ENV).toBe("production");
    expect(env.VITE_APP_NAME).toBe("Untitled");
  });

  it("supports optional values that resolve to undefined", () => {
    const env = createEnv({
      server: z.object({
        OPTIONAL_VAR: z.string().optional(),
      }),
      client: z.object({}),
      runtimeEnv: {},
    });

    expect(env.OPTIONAL_VAR).toBeUndefined();
  });

  it("throws ConfigurationError on missing required vars", () => {
    expect(() =>
      createEnv({
        server: z.object({
          REQUIRED_HOST: z.string(),
        }),
        client: z.object({}),
        runtimeEnv: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError with descriptive message on invalid value", () => {
    expect(() =>
      createEnv({
        server: z.object({
          PORT: z.coerce.number().int().positive(),
        }),
        client: z.object({}),
        runtimeEnv: { PORT: "not-a-number" },
      }),
    ).toThrow(ConfigurationError);
  });

  it("includes variable names in error message", () => {
    try {
      createEnv({
        server: z.object({
          MY_VAR: z.string().min(1),
        }),
        client: z.object({}),
        runtimeEnv: { MY_VAR: "" },
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).message).toContain("MY_VAR");
    }
  });

  it("calls onValidationError when provided", () => {
    const handler = vi.fn();

    expect(() =>
      createEnv({
        server: z.object({
          REQUIRED: z.string(),
        }),
        client: z.object({}),
        runtimeEnv: {},
        onValidationError: handler,
      }),
    ).toThrow(ConfigurationError);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: "REQUIRED" })]),
    );
  });

  it("respects onValidationError that throws custom error", () => {
    const customError = new Error("custom");

    expect(() =>
      createEnv({
        server: z.object({
          REQUIRED: z.string(),
        }),
        client: z.object({}),
        runtimeEnv: {},
        onValidationError: () => {
          throw customError;
        },
      }),
    ).toThrow(customError);
  });

  it("skips validation when skipValidation is true", () => {
    const runtimeEnv = { ANYTHING: "goes" };

    const env = createEnv({
      server: z.object({
        STRICT_REQUIRED: z.string().min(100),
      }),
      client: z.object({}),
      runtimeEnv,
      skipValidation: true,
    });

    // Returns raw env - no validation, no type safety
    expect((env as Record<string, unknown>).ANYTHING).toBe("goes");
  });

  it("uses runtimeEnv over process.env", () => {
    process.env.TEST_RUNTIME_OVERRIDE = "from-process";

    const env = createEnv({
      server: z.object({
        TEST_RUNTIME_OVERRIDE: z.string(),
      }),
      client: z.object({}),
      runtimeEnv: { TEST_RUNTIME_OVERRIDE: "from-runtime" },
    });

    expect(env.TEST_RUNTIME_OVERRIDE).toBe("from-runtime");

    delete process.env.TEST_RUNTIME_OVERRIDE;
  });

  it("falls back to process.env when runtimeEnv is not provided", () => {
    process.env.TEST_FALLBACK_VAR = "from-process-env";

    const env = createEnv({
      server: z.object({
        TEST_FALLBACK_VAR: z.string(),
      }),
      client: z.object({}),
    });

    expect(env.TEST_FALLBACK_VAR).toBe("from-process-env");

    delete process.env.TEST_FALLBACK_VAR;
  });

  it("merges shared schema with server and client", () => {
    const env = createEnv({
      server: z.object({
        SERVER_ONLY: z.string(),
      }),
      client: z.object({
        VITE_CLIENT_ONLY: z.string(),
      }),
      shared: z.object({
        SHARED_VAR: z.string(),
      }),
      runtimeEnv: {
        SERVER_ONLY: "s",
        VITE_CLIENT_ONLY: "c",
        SHARED_VAR: "both",
      },
    });

    expect(env.SERVER_ONLY).toBe("s");
    expect(env.VITE_CLIENT_ONLY).toBe("c");
    expect(env.SHARED_VAR).toBe("both");
  });

  it("returns a frozen object", () => {
    const env = createEnv({
      server: z.object({
        HOST: z.string(),
      }),
      client: z.object({}),
      runtimeEnv: { HOST: "localhost" },
    });

    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as Record<string, unknown>).HOST = "changed";
    }).toThrow();
  });
});
