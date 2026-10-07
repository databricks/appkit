import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  ClassifyRequest,
  ClassifyResponse,
  DecideRequest,
  DecideResponse,
  ExtractRequest,
  ExtractResponse,
} from "../../../plugins/ai-functions/types";
import { createApiError } from "../../../testing";
import type { WorkspaceClient } from "../../../workspace-client";
import { AiFunctionsConnector, AiFunctionsTransportError } from "../client";

const { mockApiClient, mockWorkspaceClient } = vi.hoisted(() => {
  const mockApiClient = { request: vi.fn() };
  const mockWorkspaceClient = {
    apiClient: mockApiClient,
  } as unknown as WorkspaceClient;

  return { mockApiClient, mockWorkspaceClient };
});

const { mockSpan, mockTelemetry } = vi.hoisted(() => {
  const mockSpan = {
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  };
  const mockTelemetry = {
    startActiveSpan: vi.fn(
      async (
        _name: string,
        _options: unknown,
        callback: (span: typeof mockSpan) => Promise<unknown>,
      ) => callback(mockSpan),
    ),
  };

  return { mockSpan, mockTelemetry };
});

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getProvider: vi.fn(() => mockTelemetry),
  },
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

describe("AiFunctionsConnector", () => {
  const connector = new AiFunctionsConnector();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    [
      "classify",
      {
        content: "classify this",
        labels: ["yes", "no"],
      } satisfies ClassifyRequest,
      "/api/2.0/ai-functions/ai-classify",
      { response: [{ value: "yes" }] } satisfies ClassifyResponse,
    ],
    [
      "extract",
      { content: "extract this", schema: ["name"] } satisfies ExtractRequest,
      "/api/2.0/ai-functions/ai-extract",
      { response: { name: { value: "Ada" } } } satisfies ExtractResponse,
    ],
    [
      "decide",
      {
        state: "decide this",
        questions: {
          approved: {
            type: "noul",
            instructions: "Approve?",
          },
        },
      } satisfies DecideRequest,
      "/api/2.0/ai-functions/ai-decide",
      { response: { answers: {} } } satisfies DecideResponse,
    ],
  ] as const)(
    "%s sends the parsed request to its fixed endpoint",
    async (method, request, path, response) => {
      mockApiClient.request.mockResolvedValue(response);
      const controller = new AbortController();

      const result =
        method === "classify"
          ? await connector.classify(
              mockWorkspaceClient,
              request as ClassifyRequest,
              controller.signal,
            )
          : method === "extract"
            ? await connector.extract(
                mockWorkspaceClient,
                request as ExtractRequest,
                controller.signal,
              )
            : await connector.decide(
                mockWorkspaceClient,
                request as DecideRequest,
                controller.signal,
              );

      expect(result).toBe(response);
      expect(mockApiClient.request).toHaveBeenCalledWith(
        {
          method: "POST",
          path,
          payload: request,
          headers: new Headers({ "Content-Type": "application/json" }),
          raw: false,
          query: {},
        },
        expect.objectContaining({
          cancellationToken: expect.objectContaining({
            isCancellationRequested: false,
          }),
        }),
      );
      expect(mockTelemetry.startActiveSpan).toHaveBeenCalledWith(
        `ai-functions.${method}`,
        expect.objectContaining({
          attributes: {
            "ai.function.name": method,
            "db.system": "databricks",
          },
        }),
        expect.any(Function),
        { name: "ai-functions", includePrefix: true },
      );
      expect(mockSpan.end).toHaveBeenCalledTimes(1);

      const requestContext = mockApiClient.request.mock.calls[0][1];
      controller.abort();
      expect(requestContext.cancellationToken.isCancellationRequested).toBe(
        true,
      );
    },
  );

  test("does not accept caller-supplied paths or function names", () => {
    type PublicMethodArgs = [WorkspaceClient, unknown, AbortSignal?];
    type AssertNoCallerRoute<T extends PublicMethodArgs> = T;
    type ClassifyArgsRejectRoute = AssertNoCallerRoute<
      Parameters<AiFunctionsConnector["classify"]>
    >;
    type ExtractArgsRejectRoute = AssertNoCallerRoute<
      Parameters<AiFunctionsConnector["extract"]>
    >;
    type DecideArgsRejectRoute = AssertNoCallerRoute<
      Parameters<AiFunctionsConnector["decide"]>
    >;

    void (null as unknown as
      | ClassifyArgsRejectRoute
      | ExtractArgsRejectRoute
      | DecideArgsRejectRoute);
  });

  test("does not invoke the API for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      connector.classify(
        mockWorkspaceClient,
        {
          content: "confidential request",
          labels: ["yes"],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: "AI Functions request timed out",
    });

    expect(mockApiClient.request).not.toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("sanitizes reflected SDK errors before recording and rethrowing", async () => {
    const sensitiveRequest = "secret request content";
    const rawError = createApiError({
      statusCode: 400,
      message: `Request failed: ${sensitiveRequest}`,
      errorCode: "INVALID_PARAMETER_VALUE",
    });
    mockApiClient.request.mockRejectedValue(rawError);

    const error = await connector
      .classify(mockWorkspaceClient, {
        content: sensitiveRequest,
        labels: ["yes"],
      })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(AiFunctionsTransportError);
    expect(error).toMatchObject({
      statusCode: 400,
      message: "Invalid AI Functions request",
      detail: `Request failed: ${sensitiveRequest}`,
    });
    // The upstream explanation goes to the caller, never to the span.
    expect(JSON.stringify(mockSpan.setStatus.mock.calls)).not.toContain(
      sensitiveRequest,
    );

    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "Invalid AI Functions request",
      }),
    );
    expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Invalid AI Functions request",
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, "AI Functions authentication required"],
    [403, "Not authorized to call AI Functions"],
    [429, "AI Functions rate limit exceeded"],
    [500, "AI Functions service unavailable"],
    [503, "AI Functions service unavailable"],
  ])("sanitizes HTTP %s errors", async (statusCode, message) => {
    const rawError = createApiError({
      statusCode,
      message: "reflected confidential content",
      errorCode: "ERROR",
    });
    mockApiClient.request.mockRejectedValue(rawError);

    await expect(
      connector.classify(mockWorkspaceClient, {
        content: "confidential content",
        labels: ["yes"],
      }),
    ).rejects.toMatchObject({ statusCode, message, detail: undefined });

    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode, message }),
    );
    expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message,
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("sanitizes unknown failures as a 502", async () => {
    const rawError = new Error("network confidential");
    mockApiClient.request.mockRejectedValue(rawError);

    await expect(
      connector.classify(mockWorkspaceClient, {
        content: "confidential content",
        labels: ["yes"],
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: "AI Functions request failed",
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 502,
        message: "AI Functions request failed",
      }),
    );
    expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "AI Functions request failed",
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("preserves unclassified HTTP status codes without recording raw data", async () => {
    const rawError = createApiError({
      statusCode: 413,
      message: "response body includes confidential content",
      errorCode: "REQUEST_ENTITY_TOO_LARGE",
    });
    mockApiClient.request.mockRejectedValue(rawError);

    await expect(
      connector.classify(mockWorkspaceClient, {
        content: "confidential content",
        labels: ["yes"],
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      message: "AI Functions request failed",
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 413,
        message: "AI Functions request failed",
      }),
    );
    expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test.each([0, 302, 600, 500.5])(
    "sanitizes invalid status code %s as 502",
    async (statusCode) => {
      const rawError = createApiError({
        statusCode,
        message: "response body includes confidential content",
        errorCode: "INVALID_STATUS",
      });
      mockApiClient.request.mockRejectedValue(rawError);

      await expect(
        connector.classify(mockWorkspaceClient, {
          content: "confidential content",
          labels: ["yes"],
        }),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "AI Functions request failed",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 502,
          message: "AI Functions request failed",
        }),
      );
      expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    },
  );

  test("sanitizes a mid-flight abort as a timeout", async () => {
    const controller = new AbortController();
    const rawError = new Error("request includes confidential content");
    mockApiClient.request.mockImplementation(async () => {
      controller.abort();
      throw rawError;
    });

    await expect(
      connector.classify(
        mockWorkspaceClient,
        {
          content: "confidential content",
          labels: ["yes"],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: "AI Functions request timed out",
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 504,
        message: "AI Functions request timed out",
      }),
    );
    expect(mockSpan.recordException).not.toHaveBeenCalledWith(rawError);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "AI Functions request timed out",
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("treats a completed request as a timeout when the signal aborted", async () => {
    const controller = new AbortController();
    mockApiClient.request.mockImplementation(async () => {
      controller.abort();
      return { response: [{ value: "yes" }] };
    });

    await expect(
      connector.classify(
        mockWorkspaceClient,
        {
          content: "confidential content",
          labels: ["yes"],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: "AI Functions request timed out",
    });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "AI Functions request timed out",
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});
