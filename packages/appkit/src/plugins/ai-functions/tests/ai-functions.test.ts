import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
} from "../../../testing/fixtures";

const {
  loggerDebug,
  loggerError,
  loggerWarn,
  mockRequest,
  serviceDatabricksClient,
  userDatabricksClient,
} = vi.hoisted(() => {
  const mockRequest = vi.fn();
  return {
    loggerDebug: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    mockRequest,
    serviceDatabricksClient: { apiClient: { request: mockRequest } },
    userDatabricksClient: { apiClient: { request: vi.fn() } },
  };
});

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    error: loggerError,
    warn: loggerWarn,
    debug: loggerDebug,
    info: vi.fn(),
    event: () => ({
      setComponent: vi.fn().mockReturnThis(),
      setContext: vi.fn().mockReturnThis(),
      setExecution: vi.fn().mockReturnThis(),
    }),
  }),
}));

vi.mock("../../../app", () => ({
  AppManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../../../plugin/dev-reader", () => ({
  DevFileReader: { getInstance: () => ({}) },
}));

vi.mock("../../../stream", () => ({
  StreamManager: vi.fn().mockImplementation(() => ({ abortAll: vi.fn() })),
}));

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getProvider: () => ({
      startActiveSpan: (
        _name: string,
        _options: unknown,
        fn: (span: Record<string, unknown>) => unknown,
      ) =>
        fn({
          end: vi.fn(),
          recordException: vi.fn(),
          setStatus: vi.fn(),
        }),
    }),
  },
  SpanKind: { CLIENT: 3 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
  normalizeTelemetryOptions: () => ({ traces: false, metrics: false }),
}));

import * as context from "../../../context";
import { AppKitError } from "../../../errors/base";
import { ConfigurationError } from "../../../errors/configuration";
import { InitializationError } from "../../../errors/initialization";
import { aiFunctions, AiFunctionsPlugin } from "../ai-functions";
import { AiFunctionsRequestError } from "../errors";

describe("AiFunctionsPlugin", () => {
  let serviceContextMock: ReturnType<typeof mockServiceContext>;

  beforeEach(() => {
    mockRequest.mockReset();
    userDatabricksClient.apiClient.request.mockReset();
    loggerError.mockReset();
    loggerWarn.mockReset();
    loggerDebug.mockReset();
    mockRequest.mockResolvedValue({
      response: [],
      metadata: { version: "2.1" },
    });
    userDatabricksClient.apiClient.request.mockResolvedValue({
      response: [],
      metadata: { version: "2.1" },
    });
    serviceContextMock = mockServiceContext({
      serviceDatabricksClient,
      userDatabricksClient,
    });
  });

  afterEach(() => {
    serviceContextMock.restore();
    vi.unstubAllEnvs();
  });

  it("exposes the aiFunctions factory and bound programmatic methods", () => {
    expect(aiFunctions({}).name).toBe("aiFunctions");
    expect(Object.keys(new AiFunctionsPlugin({}).exports())).toEqual([
      "classify",
      "extract",
      "decide",
      "run",
    ]);
  });

  it("sends noul, choice, and score questions", async () => {
    await new AiFunctionsPlugin({}).decide({
      state: "message",
      questions: {
        spam: {
          type: "noul",
          instructions: "Is this spam?",
          criteria: { true: "Unsolicited promotion" },
        },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", support: null },
        },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["Low", "High"],
        },
      },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/2.0/ai-functions/ai-decide",
        payload: {
          state: "message",
          questions: {
            spam: {
              type: "noul",
              instructions: "Is this spam?",
              criteria: { true: "Unsolicited promotion" },
            },
            team: {
              type: "choice",
              instructions: "Which team?",
              criteria: { billing: "Payments", support: null },
            },
            urgency: {
              type: "score",
              instructions: "How urgent?",
              criteria: ["Low", "High"],
            },
          },
          options: { version: "1.0" },
        },
      }),
      expect.anything(),
    );
  });

  it("exposes a no-op shutdown", async () => {
    await expect(new AiFunctionsPlugin({}).shutdown()).resolves.toBeUndefined();
  });

  it("parses classify requests once and injects its documented version", async () => {
    const plugin = new AiFunctionsPlugin({});

    await plugin.classify({
      content: "customer request",
      labels: ["billing", "technical"],
    });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/2.0/ai-functions/ai-classify",
        payload: expect.objectContaining({ options: { version: "2.1" } }),
      }),
      expect.anything(),
    );
  });

  it.each([
    [
      "extract",
      () =>
        new AiFunctionsPlugin({}).extract({
          content: "customer request",
          schema: ["company"],
        }),
      "/api/2.0/ai-functions/ai-extract",
    ],
    [
      "decide",
      () =>
        new AiFunctionsPlugin({}).decide({
          state: "customer request",
          questions: {
            route: {
              type: "choice",
              instructions: "Choose a route.",
              criteria: { billing: "Billing request" },
            },
          },
        }),
      "/api/2.0/ai-functions/ai-decide",
    ],
  ])(
    "calls %s through the service workspace client",
    async (_name, call, path) => {
      await call();
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path }),
        expect.anything(),
      );
    },
  );

  it("rejects unknown request fields before calling the connector", async () => {
    const plugin = new AiFunctionsPlugin({});

    await expect(
      plugin.classify({
        content: "safe",
        labels: ["one", "two"],
        unknown: "not allowed",
      } as never),
    ).rejects.toMatchObject({
      statusCode: 400,
      functionName: "classify",
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("uses the configured timeout and retry, and disables cache for users", () => {
    const plugin = new AiFunctionsPlugin({
      timeout: 123,
      cache: { enabled: true, cacheKey: ["unsafe"] },
      retry: { attempts: 5 },
    });
    const settings = (
      plugin as unknown as {
        executionSettings: () => {
          default: {
            timeout: number;
            cache: { enabled: boolean };
            retry: { enabled: boolean; attempts: number };
          };
          user: {
            timeout: number;
            cache: { enabled: boolean };
            retry: { enabled: boolean; attempts: number };
          };
        };
      }
    ).executionSettings();

    for (const config of [settings.default, settings.user]) {
      expect(config).toMatchObject({
        timeout: 123,
        cache: { enabled: false },
        retry: { enabled: true, attempts: 5, initialDelay: 1000 },
      });
    }
  });

  it("turns retry off when configured", () => {
    const plugin = new AiFunctionsPlugin({ retry: { enabled: false } });
    expect(
      (
        plugin as unknown as {
          executionSettings: () => { default: { retry: { enabled: boolean } } };
        }
      ).executionSettings().default.retry.enabled,
    ).toBe(false);
  });

  it.each([429, 503])(
    "retries HTTP %s and then succeeds",
    async (statusCode) => {
      mockRequest
        .mockRejectedValueOnce({ statusCode, message: "busy" })
        .mockResolvedValueOnce({ response: [{ value: "one" }] });
      const plugin = new AiFunctionsPlugin({
        retry: { initialDelay: 1, maxDelay: 1 },
      });

      await expect(
        plugin.classify({ content: "safe", labels: ["one", "two"] }),
      ).resolves.toMatchObject({ response: [{ value: "one" }] });
      expect(mockRequest).toHaveBeenCalledTimes(2);
    },
  );

  it.each([400, 401, 403, 500, 504])(
    "does not retry HTTP %s",
    async (statusCode) => {
      mockRequest.mockRejectedValue({ statusCode, message: "nope" });
      const plugin = new AiFunctionsPlugin({
        retry: { initialDelay: 1, maxDelay: 1 },
      });

      await expect(
        plugin.classify({ content: "safe", labels: ["one", "two"] }),
      ).rejects.toMatchObject({ statusCode });
      expect(mockRequest).toHaveBeenCalledTimes(1);
    },
  );

  it("includes the upstream 400 explanation in the request error", async () => {
    mockRequest.mockRejectedValue(
      Object.assign(new Error("Schema cannot be empty."), { statusCode: 400 }),
    );
    const plugin = new AiFunctionsPlugin({});

    await expect(
      plugin.extract({ content: "safe", schema: ["field"] }),
    ).rejects.toMatchObject({
      statusCode: 400,
      functionName: "extract",
      message: "Invalid AI Functions request: Schema cannot be empty.",
      isRetryable: false,
    });
  });

  it("defaults the timeout to 60 seconds", () => {
    const plugin = new AiFunctionsPlugin({});
    expect(
      (
        plugin as unknown as {
          executionSettings: () => { default: { timeout: number } };
        }
      ).executionSettings().default.timeout,
    ).toBe(60_000);
  });

  it("clamps a non-positive timeout to 60 seconds", () => {
    const plugin = new AiFunctionsPlugin({ timeout: 0 });
    expect(
      (
        plugin as unknown as {
          executionSettings: () => { default: { timeout: number } };
        }
      ).executionSettings().default.timeout,
    ).toBe(60_000);
  });

  it("maps failed execution results to the public request error", async () => {
    mockRequest.mockRejectedValue({
      statusCode: 503,
      message: "raw upstream detail",
    });
    const plugin = new AiFunctionsPlugin({ retry: { enabled: false } });

    await expect(
      plugin.classify({ content: "safe", labels: ["one", "two"] }),
    ).rejects.toMatchObject({
      statusCode: 503,
      functionName: "classify",
      message: "AI Functions service unavailable",
      clientMessage: "AI Functions service unavailable",
    });
  });

  it("maps unknown connector failures to 502 request failed", async () => {
    mockRequest.mockRejectedValue(new Error("raw upstream detail"));
    const plugin = new AiFunctionsPlugin({});

    await expect(
      plugin.classify({ content: "safe", labels: ["one", "two"] }),
    ).rejects.toMatchObject({
      statusCode: 502,
      functionName: "classify",
      message: "AI Functions request failed",
      clientMessage: "AI Functions request failed",
    });
  });

  it("preserves workspace client setup errors", async () => {
    vi.spyOn(context, "getWorkspaceClient").mockImplementationOnce(() => {
      throw new Error("workspace client setup failed");
    });
    const plugin = new AiFunctionsPlugin({});

    await expect(
      plugin.classify({ content: "safe", labels: ["one", "two"] }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "workspace client setup failed",
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(context.getWorkspaceClient).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Plugin execution failed",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "workspace client setup failed",
        }),
      }),
    );
  });

  it("maps aborted requests to 504 and forwards the aborted signal", async () => {
    let cancellationRequested = false;
    mockRequest.mockImplementation(
      (
        _request,
        context: {
          cancellationToken: {
            onCancellationRequested: (fn: () => void) => void;
          };
        },
      ) =>
        new Promise((_, reject) => {
          context.cancellationToken.onCancellationRequested(() => {
            cancellationRequested = true;
            reject(new Error("aborted request body"));
          });
        }),
    );
    const plugin = new AiFunctionsPlugin({ timeout: 1 });

    await expect(
      plugin.classify({ content: "safe", labels: ["one", "two"] }),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: "AI Functions request timed out",
    });
    expect(cancellationRequested).toBe(true);
  });

  it("reports a caller's own abort as canceled (499), not a timeout", async () => {
    mockRequest.mockImplementation(
      (
        _request,
        context: {
          cancellationToken: {
            onCancellationRequested: (fn: () => void) => void;
          };
        },
      ) =>
        new Promise((_, reject) => {
          context.cancellationToken.onCancellationRequested(() =>
            reject(new Error("aborted request body")),
          );
        }),
    );
    const plugin = new AiFunctionsPlugin({});
    const controller = new AbortController();
    const pending = plugin.run(
      { function: "classify", labels: ["one", "two"] },
      { content: "safe" },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      statusCode: 499,
      message: "AI Functions request was canceled",
      isRetryable: false,
    });
  });

  it.each([
    [400, "Invalid AI Functions request"],
    [500, "AI Functions service unavailable"],
  ])(
    "keeps an upstream %i when the caller's signal aborts at the same time",
    async (statusCode, message) => {
      const controller = new AbortController();
      mockRequest.mockImplementation(async () => {
        controller.abort();
        throw { statusCode, message: "upstream failure" };
      });
      const plugin = new AiFunctionsPlugin({ retry: { enabled: false } });

      await expect(
        plugin.run(
          { function: "classify", labels: ["one", "two"] },
          { content: "safe" },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        statusCode,
        message: expect.stringContaining(message),
      });
    },
  );

  it("reports a timeout as 504 even when a caller signal is also passed", async () => {
    mockRequest.mockImplementation(
      (
        _request,
        context: {
          cancellationToken: {
            onCancellationRequested: (fn: () => void) => void;
          };
        },
      ) =>
        new Promise((_, reject) => {
          context.cancellationToken.onCancellationRequested(() =>
            reject(new Error("aborted request body")),
          );
        }),
    );
    const plugin = new AiFunctionsPlugin({ timeout: 1 });

    await expect(
      plugin.run(
        { function: "classify", labels: ["one", "two"] },
        { content: "safe" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: "AI Functions request timed out",
    });
  });

  it("provides the AppKit error contract for validation failures", async () => {
    const plugin = new AiFunctionsPlugin({});

    await expect(plugin.classify({} as never)).rejects.toSatisfy(
      (error: unknown) => {
        return (
          error instanceof AiFunctionsRequestError &&
          error instanceof AppKitError &&
          error.statusCode === 400 &&
          error.code === "AI_FUNCTIONS_REQUEST_ERROR" &&
          error.isRetryable === false &&
          error.clientMessage === error.message
        );
      },
    );
  });

  it("never reflects request text into public errors or logger input", async () => {
    const secret = "confidential request content";
    vi.stubEnv("NODE_ENV", "production");
    mockRequest.mockRejectedValue({
      statusCode: 500,
      message: `SDK failure: ${secret}`,
    });
    const plugin = new AiFunctionsPlugin({});

    await expect(
      plugin.classify({ content: secret, labels: ["one", "two"] }),
    ).rejects.toMatchObject({ message: "AI Functions service unavailable" });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(loggerDebug.mock.calls)).not.toContain(secret);
  });

  describe("task route", () => {
    const tasks = {
      routeTicket: { function: "classify", labels: ["billing", "technical"] },
      spamCheck: {
        function: "decide",
        questions: { spam: { type: "noul", instructions: "Spam?" } },
        auth: "on-behalf-of-user",
      },
    } as const;

    function setup(
      config: ConstructorParameters<typeof AiFunctionsPlugin>[0] = { tasks },
    ) {
      const plugin = new AiFunctionsPlugin(config);
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      return { plugin, handler: getHandler("POST", "/:task/invoke") };
    }

    async function call(
      handler: (req: unknown, res: unknown) => Promise<void>,
      task: string,
      body: unknown,
      obo = true,
    ) {
      const res = createMockResponse();
      await handler(createMockRequest({ params: { task }, body, obo }), res);
      return res;
    }

    it("runs a service-principal task with the service client, without asUser", async () => {
      const { plugin, handler } = setup();
      const asUser = vi.spyOn(plugin, "asUser");
      const res = await call(handler, "routeTicket", {
        content: "refund please",
      });
      expect(asUser).not.toHaveBeenCalled();
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/2.0/ai-functions/ai-classify",
          payload: {
            content: "refund please",
            labels: ["billing", "technical"],
            options: { version: "2.1" },
          },
        }),
        expect.anything(),
      );
      expect(res.json).toHaveBeenCalledWith({
        response: [],
        metadata: { version: "2.1" },
      });
    });

    it("runs an on-behalf-of-user task with the user client", async () => {
      const { handler } = setup();
      await call(handler, "spamCheck", { state: "win a prize" });
      expect(userDatabricksClient.apiClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/api/2.0/ai-functions/ai-decide" }),
        expect.anything(),
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it.each(["missing", "__proto__", "constructor", "toString"])(
      "returns 404 for unknown task %s",
      async (task) => {
        const { handler } = setup();
        const res = await call(handler, task, { content: "x" });
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
          error: `No task configured with name "${task}"`,
          plugin: "aiFunctions",
        });
      },
    );

    it("returns the plugin's 404 when no tasks are configured", async () => {
      const { handler } = setup({});
      const res = await call(handler, "routeTicket", { content: "x" });
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it.each([
      [
        { content: "x", labels: ["evil", "override"] },
        'unrecognized_keys: request has unknown key "labels"',
      ],
      [{ content: "   " }, "content must not be empty"],
      [{ state: "x" }, 'unrecognized_keys: request has unknown key "state"'],
    ])("rejects body %j with 400", async (body, message) => {
      const { handler } = setup();
      const res = await call(handler, "routeTicket", body);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: message,
        plugin: "aiFunctions",
      });
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("passes upstream errors through with status and message", async () => {
      mockRequest.mockRejectedValue(
        Object.assign(new Error("Must provide at least 2 unique labels."), {
          statusCode: 400,
        }),
      );
      const { handler } = setup();
      const res = await call(handler, "routeTicket", { content: "x" });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error:
          "Invalid AI Functions request: Must provide at least 2 unique labels.",
        plugin: "aiFunctions",
      });
    });

    const oboTicket = {
      function: "classify",
      labels: ["billing", "technical"],
      auth: "on-behalf-of-user",
    } as const;

    it.each([401, 403, 429, 500, 504] as const)(
      "preserves connector-sanitized status %i",
      async (statusCode) => {
        userDatabricksClient.apiClient.request.mockRejectedValue({
          statusCode,
        });
        const { handler } = setup({
          retry: { enabled: false },
          tasks: { oboTicket },
        });
        const res = await call(handler, "oboTicket", { content: "x" });

        const messages = {
          // A user task's 401 is AppKit's expired-token error (IDENTITY_EXPIRED).
          401: "Caller credentials were rejected or expired. Reauthenticate and retry with a fresh user token.",
          403: "Not authorized to call AI Functions",
          429: "AI Functions rate limit exceeded",
          500: "AI Functions service unavailable",
          504: "AI Functions request timed out",
        };
        expect(res.status).toHaveBeenCalledWith(statusCode);
        expect(res.json).toHaveBeenCalledWith({
          error: messages[statusCode],
          plugin: "aiFunctions",
        });
      },
    );

    it("returns 504 when an upstream request times out", async () => {
      userDatabricksClient.apiClient.request.mockImplementation(
        (
          _request: unknown,
          context: {
            cancellationToken: {
              onCancellationRequested: (fn: () => void) => void;
            };
          },
        ) =>
          new Promise((_, reject) => {
            context.cancellationToken.onCancellationRequested(() => {
              reject(new Error("aborted request body"));
            });
          }),
      );
      const { handler } = setup({ timeout: 1, tasks: { oboTicket } });
      const res = await call(handler, "oboTicket", { content: "x" });

      expect(res.status).toHaveBeenCalledWith(504);
      expect(res.json).toHaveBeenCalledWith({
        error: "AI Functions request timed out",
        plugin: "aiFunctions",
      });
    });

    it("no longer mounts the open routes", () => {
      const plugin = new AiFunctionsPlugin({ tasks });
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      for (const path of ["/classify", "/extract", "/decide"]) {
        expect(getHandler("POST", path)).toBeUndefined();
      }
    });

    it("publishes only task names and kinds in clientConfig", () => {
      const plugin = new AiFunctionsPlugin({
        tasks: {
          ...tasks,
          secret: {
            function: "classify",
            labels: ["s1", "s2"],
            options: { instructions: "do not leak" },
            description: "hidden",
          },
        },
      });
      const config = plugin.clientConfig();
      expect(config).toEqual({
        tasks: {
          routeTicket: { function: "classify" },
          spamCheck: { function: "decide" },
          secret: { function: "classify" },
        },
      });
      expect(JSON.stringify(config)).not.toMatch(
        /labels|questions|schema|instructions|auth|leak|hidden|s1/,
      );
    });

    it("clientConfig is { tasks: {} } with no tasks", () => {
      expect(new AiFunctionsPlugin({}).clientConfig()).toEqual({ tasks: {} });
    });
  });

  describe("on-behalf-of-user tasks without a user token", () => {
    // The file's afterEach already calls vi.unstubAllEnvs().
    const spamTasks = {
      spamCheck: {
        function: "decide",
        questions: { s: { type: "noul", instructions: "?" } },
        auth: "on-behalf-of-user",
      },
    } as const;

    it("runs as the service principal with a warning in development", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const plugin = new AiFunctionsPlugin({ tasks: spamTasks });
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const res = createMockResponse();
      await getHandler("POST", "/:task/invoke")(
        createMockRequest({
          params: { task: "spamCheck" },
          body: { state: "x" },
        }),
        res,
      );
      expect(mockRequest).toHaveBeenCalled();
      expect(userDatabricksClient.apiClient.request).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        response: [],
        metadata: { version: "2.1" },
      });
      expect(loggerWarn).toHaveBeenCalledWith(
        "asUser() called without user token in development mode. Skipping user impersonation.",
      );
    });

    it("returns 400 for a bad body before checking identity in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const plugin = new AiFunctionsPlugin({ tasks: spamTasks });
      const asUser = vi.spyOn(plugin, "asUser");
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const res = createMockResponse();
      await getHandler("POST", "/:task/invoke")(
        createMockRequest({
          params: { task: "spamCheck" },
          body: { content: "x" },
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(asUser).not.toHaveBeenCalled();
    });

    it("rejects with 401 in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const plugin = new AiFunctionsPlugin({ tasks: spamTasks });
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      // asUser throws AuthenticationError; forwardAsyncErrors makes the handler reject.
      await expect(
        getHandler("POST", "/:task/invoke")(
          createMockRequest({
            params: { task: "spamCheck" },
            body: { state: "x" },
          }),
          createMockResponse(),
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  it("serves a service-principal task in production without a user token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const plugin = new AiFunctionsPlugin({
      tasks: {
        routeTicket: { function: "classify", labels: ["billing", "technical"] },
      },
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    const res = createMockResponse();
    await getHandler("POST", "/:task/invoke")(
      createMockRequest({
        params: { task: "routeTicket" },
        body: { content: "x" },
      }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith({
      response: [],
      metadata: { version: "2.1" },
    });
  });

  it("tags task route calls with ai.function.task", async () => {
    const plugin = new AiFunctionsPlugin({
      tasks: {
        routeTicket: { function: "classify", labels: ["billing", "technical"] },
      },
    });
    const exec = vi.spyOn(
      plugin as unknown as { execute: (...args: unknown[]) => unknown },
      "execute",
    );
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    await getHandler("POST", "/:task/invoke")(
      createMockRequest({
        params: { task: "routeTicket" },
        body: { content: "x" },
      }),
      createMockResponse(),
    );
    expect(
      (
        exec.mock.calls[0][1] as {
          default: { telemetryInterceptor?: { attributes?: unknown } };
        }
      ).default.telemetryInterceptor?.attributes,
    ).toEqual({
      "ai.function.task": "routeTicket",
      "ai.function.auth": "service-principal",
    });
  });

  it("uses the stored parse, not the live config object", async () => {
    const labels = ["billing", "technical"];
    const plugin = new AiFunctionsPlugin({
      tasks: { routeTicket: { function: "classify", labels } },
    });
    labels.push("mutated-after-construction");
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    await getHandler("POST", "/:task/invoke")(
      createMockRequest({
        params: { task: "routeTicket" },
        body: { content: "x" },
        obo: true,
      }),
      createMockResponse(),
    );
    expect(mockRequest).toHaveBeenCalledTimes(1);
    for (const [request] of mockRequest.mock.calls) {
      expect(
        (request as { payload: { labels: string[] } }).payload.labels,
      ).toEqual(["billing", "technical"]);
    }
  });

  describe("tasks", () => {
    it("uses the service workspace client for programmatic calls", async () => {
      const plugin = new AiFunctionsPlugin({});
      await plugin.classify({
        content: "customer request",
        labels: ["billing", "technical"],
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/2.0/ai-functions/ai-classify",
        }),
        expect.anything(),
      );
      expect(userDatabricksClient.apiClient.request).not.toHaveBeenCalled();
    });

    it("uses the user workspace client for OBO programmatic calls", async () => {
      const plugin = new AiFunctionsPlugin({});
      await plugin
        .asUser(
          createMockRequest({
            obo: true,
          }) as never,
        )
        .classify({
          content: "customer request",
          labels: ["billing", "technical"],
        });

      expect(userDatabricksClient.apiClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/2.0/ai-functions/ai-classify",
        }),
        expect.anything(),
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    const routeTicket = {
      function: "classify",
      labels: { billing: "Payments", technical: "Bugs" },
    } as const;

    it("validates tasks in the constructor and names the bad task", () => {
      expect(
        () =>
          new AiFunctionsPlugin({
            tasks: {
              broken: { function: "classify", labels: ["only"] },
            } as never,
          }),
      ).toThrow(
        'aiFunctions task "broken": too_small: labels must have at least 2 items',
      );
    });

    it("rejects task names that aren't URL- and tool-safe", () => {
      expect(
        () => new AiFunctionsPlugin({ tasks: { "has space": routeTicket } }),
      ).toThrow(
        'aiFunctions task "has space": name must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$',
      );
    });

    it("throws a ConfigurationError with no labels or content in the message", () => {
      let error: unknown;
      try {
        new AiFunctionsPlugin({
          tasks: {
            t: { function: "classify", labels: ["secret-label"] },
          } as never,
        });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain("secret-label");
    });

    it("warns once when no tasks are configured", () => {
      const WARNING =
        "aiFunctions has no tasks configured; HTTP routes and agent tools are inactive";
      new AiFunctionsPlugin({});
      expect(
        loggerWarn.mock.calls.filter(([message]) => message === WARNING),
      ).toHaveLength(1);
    });

    it("doesn't warn when tasks are configured", () => {
      new AiFunctionsPlugin({ tasks: { routeTicket } });
      expect(loggerWarn).not.toHaveBeenCalledWith(
        "aiFunctions has no tasks configured; HTTP routes and agent tools are inactive",
      );
    });

    it("run() merges the task with the input and pins the version", async () => {
      const plugin = new AiFunctionsPlugin({});
      await plugin.run(routeTicket, { content: "Charged twice" });
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/2.0/ai-functions/ai-classify",
          payload: {
            content: "Charged twice",
            labels: { billing: "Payments", technical: "Bugs" },
            options: { version: "2.1" },
          },
        }),
        expect.anything(),
      );
    });

    it("run() rejects an invalid ad-hoc task with a 400 request error", async () => {
      const plugin = new AiFunctionsPlugin({});
      await expect(
        plugin.run(
          { function: "classify", labels: ["only"] } as never,
          { content: "x" } as never,
        ),
      ).rejects.toMatchObject({
        name: "AiFunctionsRequestError",
        statusCode: 400,
        functionName: "classify",
      });
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("run() rejects extra input keys", async () => {
      const plugin = new AiFunctionsPlugin({});
      await expect(
        plugin.run(routeTicket, { content: "x", labels: ["a"] } as never),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'unrecognized_keys: request has unknown key "labels"',
      });
    });

    it("run() follows the caller's context, not the task's auth", async () => {
      const plugin = new AiFunctionsPlugin({});
      await plugin
        .asUser(createMockRequest({ obo: true }) as never)
        .run({ ...routeTicket, auth: "service-principal" }, { content: "x" });
      expect(userDatabricksClient.apiClient.request).toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("doesn't tag direct calls or run() with ai.function.task", async () => {
      const plugin = new AiFunctionsPlugin({});
      const exec = vi.spyOn(
        plugin as unknown as { execute: (...args: unknown[]) => unknown },
        "execute",
      );
      await plugin.classify({ content: "x", labels: ["a", "b"] });
      await plugin.run(routeTicket, { content: "x" });
      expect(exec).toHaveBeenCalledTimes(2);
      for (const call of exec.mock.calls) {
        expect(
          (call[1] as { default: Record<string, unknown> }).default
            .telemetryInterceptor,
        ).toBeUndefined();
      }
    });

    it("run(null) rejects with a 400 instead of a TypeError", async () => {
      const plugin = new AiFunctionsPlugin({});
      await expect(
        plugin.run(null as never, { content: "x" } as never),
      ).rejects.toMatchObject({
        name: "AiFunctionsRequestError",
        statusCode: 400,
      });
    });

    it("run() with an on-behalf-of-user task outside asUser uses the service client", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const plugin = new AiFunctionsPlugin({});
      await plugin.run(
        { ...routeTicket, auth: "on-behalf-of-user" },
        { content: "x" },
      );
      expect(mockRequest).toHaveBeenCalled();
      expect(userDatabricksClient.apiClient.request).not.toHaveBeenCalled();
    });

    it("keeps the upstream 400 detail out of the error thrown inside execute()", async () => {
      mockRequest.mockRejectedValue(
        Object.assign(new Error("Schema cannot be empty."), {
          statusCode: 400,
        }),
      );
      const plugin = new AiFunctionsPlugin({});
      await expect(
        plugin.extract({ content: "x", schema: ["field"] }),
      ).rejects.toMatchObject({
        message: "Invalid AI Functions request: Schema cannot be empty.",
      });
      // Plugin.execute logs the error it caught, the same object TelemetryInterceptor
      // passes to span.recordException. Neither may carry the detail.
      const logged = loggerError.mock.calls.find(
        ([message]) => message === "Plugin execution failed",
      );
      expect(logged).toBeDefined();
      const loggedError = (
        logged?.[1] as { error: Error & { clientMessage?: string } }
      ).error;
      expect(loggedError).toBeInstanceOf(AiFunctionsRequestError);
      expect(
        `${loggedError.message} ${loggedError.clientMessage} ${loggedError.stack}`,
      ).not.toContain("Schema cannot be empty");
    });

    it("wraps retryable setup errors as non-retryable", () => {
      const plugin = new AiFunctionsPlugin({});
      const resolve = (
        plugin as unknown as { resolveClient: (r: () => unknown) => unknown }
      ).resolveClient.bind(plugin);
      let error: unknown;
      try {
        resolve(() => {
          throw new InitializationError("ServiceContext not initialized");
        });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(AppKitError);
      expect((error as AppKitError).isRetryable).toBe(false);
    });
  });
});

describe("manifest", () => {
  it("documents tasks, retry, and scaffolding in the manifest", async () => {
    const manifest = (await import("../manifest.json")).default as {
      config: {
        schema: {
          properties: Record<string, { description?: string; type?: string }>;
        };
      };
      scaffolding?: { rules?: { must?: string[]; should?: string[] } };
    };
    expect(manifest.config.schema.properties.tasks.type).toBe("object");
    expect(manifest.config.schema.properties.retry.description).toContain(
      "503",
    );
    expect(manifest.config.schema.properties.retry.description).toContain(
      "504",
    );
    expect(manifest.scaffolding?.rules?.must?.[0]).toContain(
      "aiFunctions({ tasks })",
    );
    for (const rule of [
      ...(manifest.scaffolding?.rules?.must ?? []),
      ...(manifest.scaffolding?.rules?.should ?? []),
    ]) {
      expect(rule.length).toBeLessThanOrEqual(120); // PLUGIN_SCAFFOLDING_RULE_MAX_LENGTH in shared/src/schemas/manifest.ts
    }
  });
});
