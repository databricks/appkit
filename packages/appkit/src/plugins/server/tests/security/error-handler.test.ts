import express from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppKitError } from "../../../../errors/base";
import { createErrorHandler } from "../../security/error-handler";

class TestAppKitError extends AppKitError {
  readonly code = "TEST_ERROR";
  readonly statusCode = 422;
  readonly isRetryable = false;
}

function createTestApp(
  config?: Parameters<typeof createErrorHandler>[0],
  routeSetup?: (app: express.Application) => void,
) {
  const app = express();
  app.use(express.json());

  if (routeSetup) {
    routeSetup(app);
  } else {
    app.get("/throw-appkit", (_req, res, next) => {
      next(
        new TestAppKitError("Something went wrong", {
          context: { userId: "123" },
        }),
      );
    });
    app.get("/throw-generic", (_req, res, next) => {
      next(new Error("Unexpected failure with secret-token-abc"));
    });
    app.post("/parse-json", (req, res) => {
      res.json({ received: req.body });
    });
  }

  app.use(createErrorHandler(config));
  return app;
}

async function request(
  app: express.Application,
  method: string,
  path: string,
  options?: { body?: string; headers?: Record<string, string> },
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: options?.headers,
      body: options?.body,
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Error Handler Middleware", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("production mode", () => {
    test("AppKitError returns statusCode and code, not message", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/throw-appkit");
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Internal Server Error");
      expect(res.body.code).toBe("TEST_ERROR");
      expect(res.body.stack).toBeUndefined();
      expect(res.body.message).toBeUndefined();
    });

    test("AppKitError hides code when includeErrorCode is false", async () => {
      const app = createTestApp({ includeErrorCode: false });
      const res = await request(app, "GET", "/throw-appkit");
      expect(res.status).toBe(422);
      expect(res.body.code).toBeUndefined();
    });

    test("generic error returns 500 with no details", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/throw-generic");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Internal Server Error");
      expect(res.body.stack).toBeUndefined();
      // Should not leak the error message with "secret-token"
      expect(JSON.stringify(res.body)).not.toContain("secret-token");
    });

    test("malformed JSON returns 400 Bad Request", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/parse-json", {
        body: "{invalid json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Bad Request");
      expect(res.body.message).toBeUndefined();
    });
  });

  describe("dev mode", () => {
    test("includes message and stack in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const app = createTestApp();
      const res = await request(app, "GET", "/throw-generic");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Unexpected failure");
      expect(res.body.stack).toBeDefined();
    });

    test("AppKitError includes message in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const app = createTestApp();
      const res = await request(app, "GET", "/throw-appkit");
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("Something went wrong");
      expect(res.body.code).toBe("TEST_ERROR");
      expect(res.body.stack).toBeDefined();
    });

    test("malformed JSON includes message in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const app = createTestApp();
      const res = await request(app, "POST", "/parse-json", {
        body: "{bad",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
    });
  });

  describe("disabled", () => {
    test("errorHandler: false passes errors through", async () => {
      const app = express();
      app.get("/throw", (_req, _res, next) => {
        next(new Error("test"));
      });
      app.use(createErrorHandler(false));
      // Express default handler will return HTML 500
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/throw`);
        // Express default error handler returns 500 with HTML
        expect(res.status).toBe(500);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
