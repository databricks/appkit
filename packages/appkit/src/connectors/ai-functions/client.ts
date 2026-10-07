import type { TelemetryOptions } from "shared";

import { createLogger } from "../../logging/logger";
import type {
  ClassifyRequest,
  ClassifyResponse,
  DecideRequest,
  DecideResponse,
  ExtractRequest,
  ExtractResponse,
} from "../../plugins/ai-functions/types";
import {
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
  type TelemetryProvider,
} from "../../telemetry";
import type { WorkspaceClient } from "../../workspace-client";
import { contextFromAbortSignal } from "../context";

const logger = createLogger("connectors:ai-functions");

const AI_FUNCTIONS_PATHS = {
  classify: "/api/2.0/ai-functions/ai-classify",
  extract: "/api/2.0/ai-functions/ai-extract",
  decide: "/api/2.0/ai-functions/ai-decide",
} as const;

type AiFunctionName = keyof typeof AI_FUNCTIONS_PATHS;

/** Longest upstream 400 message kept as `detail`. */
const MAX_DETAIL_CHARS = 500;

export class AiFunctionsTransportError extends Error {
  /**
   * Upstream explanation for a 400, such as which schema field is invalid.
   * Kept off `message` so spans and span status stay generic.
   */
  readonly detail?: string;

  /** True when the request was cut short by its abort signal. */
  readonly aborted: boolean;

  constructor(
    message: string,
    readonly statusCode: number,
    options: { detail?: string; aborted?: boolean } = {},
  ) {
    super(message);
    this.name = "AiFunctionsTransportError";
    if (options.detail) this.detail = options.detail;
    this.aborted = options.aborted ?? false;
  }
}

interface AiFunctionsConnectorConfig {
  telemetry?: TelemetryOptions;
}

export class AiFunctionsConnector {
  private readonly telemetry: TelemetryProvider;

  constructor(config: AiFunctionsConnectorConfig = {}) {
    this.telemetry = TelemetryManager.getProvider(
      "ai-functions",
      config.telemetry,
    );
  }

  classify(
    client: WorkspaceClient,
    payload: ClassifyRequest,
    signal?: AbortSignal,
  ): Promise<ClassifyResponse> {
    return this.invoke(client, AI_FUNCTIONS_PATHS.classify, payload, signal);
  }

  extract(
    client: WorkspaceClient,
    payload: ExtractRequest,
    signal?: AbortSignal,
  ): Promise<ExtractResponse> {
    return this.invoke(client, AI_FUNCTIONS_PATHS.extract, payload, signal);
  }

  decide(
    client: WorkspaceClient,
    payload: DecideRequest,
    signal?: AbortSignal,
  ): Promise<DecideResponse> {
    return this.invoke(client, AI_FUNCTIONS_PATHS.decide, payload, signal);
  }

  private invoke<TRequest, TResponse>(
    client: WorkspaceClient,
    path: (typeof AI_FUNCTIONS_PATHS)[keyof typeof AI_FUNCTIONS_PATHS],
    payload: TRequest,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const functionName = this.functionNameForPath(path);

    return this.telemetry.startActiveSpan(
      `ai-functions.${functionName}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "ai.function.name": functionName,
          "db.system": "databricks",
        },
      },
      async (span: Span) => {
        try {
          if (signal?.aborted) {
            throw this.sanitizeError(undefined, signal);
          }

          logger.debug("Calling AI Functions %s", functionName);

          const response = await client.apiClient.request(
            {
              method: "POST",
              path,
              payload,
              headers: new Headers({ "Content-Type": "application/json" }),
              raw: false,
              query: {},
            },
            contextFromAbortSignal(signal),
          );

          if (signal?.aborted) {
            throw this.sanitizeError(undefined, signal);
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return response as TResponse;
        } catch (error) {
          const sanitized =
            error instanceof AiFunctionsTransportError
              ? error
              : this.sanitizeError(error, signal);
          span.recordException(sanitized);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: sanitized.message,
          });
          logger.debug(
            "AI Functions %s failed (%s)",
            functionName,
            sanitized.statusCode,
          );
          throw sanitized;
        } finally {
          span.end();
        }
      },
      { name: "ai-functions", includePrefix: true },
    );
  }

  private sanitizeError(
    error: unknown,
    signal?: AbortSignal,
  ): AiFunctionsTransportError {
    const statusCode =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const status =
      typeof statusCode === "number" && Number.isInteger(statusCode)
        ? statusCode
        : undefined;

    // An upstream HTTP status wins over a signal that aborted afterwards, so
    // a real failure isn't reported as a timeout.
    if (signal?.aborted && status === undefined) {
      return new AiFunctionsTransportError(
        "AI Functions request timed out",
        504,
        { aborted: true },
      );
    }

    switch (status) {
      case 400:
        return new AiFunctionsTransportError(
          "Invalid AI Functions request",
          400,
          { detail: this.upstreamDetail(error) },
        );
      case 401:
        return new AiFunctionsTransportError(
          "AI Functions authentication required",
          401,
        );
      case 403:
        return new AiFunctionsTransportError(
          "Not authorized to call AI Functions",
          403,
        );
      case 429:
        return new AiFunctionsTransportError(
          "AI Functions rate limit exceeded",
          429,
        );
      case 504:
        return new AiFunctionsTransportError(
          "AI Functions request timed out",
          504,
        );
      default:
        if (status !== undefined && status >= 500 && status < 600) {
          return new AiFunctionsTransportError(
            "AI Functions service unavailable",
            status,
          );
        }
        if (status !== undefined && status >= 400 && status < 500) {
          return new AiFunctionsTransportError(
            "AI Functions request failed",
            status,
          );
        }
        return new AiFunctionsTransportError(
          "AI Functions request failed",
          502,
        );
    }
  }

  private upstreamDetail(error: unknown): string | undefined {
    const message =
      error instanceof Error
        ? error.message
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : undefined;
    const trimmed = message?.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
      : trimmed;
  }

  private functionNameForPath(
    path: (typeof AI_FUNCTIONS_PATHS)[keyof typeof AI_FUNCTIONS_PATHS],
  ): AiFunctionName {
    if (path === AI_FUNCTIONS_PATHS.classify) return "classify";
    if (path === AI_FUNCTIONS_PATHS.extract) return "extract";
    return "decide";
  }
}
