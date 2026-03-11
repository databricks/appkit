import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../errors";
import { createEnv } from "../create-env";

describe("createEnv client prefix enforcement", () => {
  it("accepts client keys that match the default VITE_ prefix", () => {
    const env = createEnv({
      server: z.object({}),
      client: z.object({
        VITE_APP_NAME: z.string(),
        VITE_API_URL: z.string(),
      }),
      runtimeEnv: {
        VITE_APP_NAME: "test",
        VITE_API_URL: "http://localhost",
      },
    });

    expect(env.VITE_APP_NAME).toBe("test");
    expect(env.VITE_API_URL).toBe("http://localhost");
  });

  it("throws when client key does not start with VITE_", () => {
    expect(() =>
      createEnv({
        server: z.object({}),
        client: z.object({
          APP_NAME: z.string(),
        } as Record<string, z.ZodString>),
        runtimeEnv: { APP_NAME: "test" },
      }),
    ).toThrow(ConfigurationError);
  });

  it("includes invalid key names in the error message", () => {
    try {
      createEnv({
        server: z.object({}),
        client: z.object({
          NO_PREFIX: z.string(),
          ALSO_BAD: z.string(),
        } as Record<string, z.ZodString>),
        runtimeEnv: { NO_PREFIX: "a", ALSO_BAD: "b" },
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      const msg = (e as ConfigurationError).message;
      expect(msg).toContain("NO_PREFIX");
      expect(msg).toContain("ALSO_BAD");
      expect(msg).toContain('VITE_"');
    }
  });

  it("supports custom clientPrefix", () => {
    const env = createEnv({
      server: z.object({}),
      client: z.object({
        PUBLIC_TITLE: z.string(),
      } as Record<string, z.ZodString>),
      clientPrefix: "PUBLIC_",
      runtimeEnv: { PUBLIC_TITLE: "hello" },
    });

    expect(env.PUBLIC_TITLE).toBe("hello");
  });

  it("rejects keys not matching custom prefix", () => {
    expect(() =>
      createEnv({
        server: z.object({}),
        client: z.object({
          VITE_WRONG: z.string(),
        } as Record<string, z.ZodString>),
        clientPrefix: "PUBLIC_",
        runtimeEnv: { VITE_WRONG: "test" },
      }),
    ).toThrow(ConfigurationError);
  });

  it("allows empty client schema", () => {
    const env = createEnv({
      server: z.object({
        HOST: z.string(),
      }),
      client: z.object({}),
      runtimeEnv: { HOST: "localhost" },
    });

    expect(env.HOST).toBe("localhost");
  });

  it("prefix check runs before validation", () => {
    // Even if env vars are valid, prefix violation should throw first
    expect(() =>
      createEnv({
        server: z.object({}),
        client: z.object({
          BAD_KEY: z.string(),
        } as Record<string, z.ZodString>),
        runtimeEnv: { BAD_KEY: "value" },
      }),
    ).toThrow(/must start with/);
  });
});
