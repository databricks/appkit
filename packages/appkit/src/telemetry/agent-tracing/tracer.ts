import { randomUUID } from "node:crypto";
import {
  context,
  isSpanContextValid,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type {
  AgentModelEndEvent,
  AgentModelStartEvent,
  AgentUsage,
} from "shared";
import { getMlflowUcTraceId } from "../mlflow-uc";
import { captureTraceValue } from "./serialization";
import type {
  AgentTraceIdentity,
  AgentTraceObserver,
  AgentTraceResult,
} from "./types";
import { AgentUsageAccumulator } from "./usage";

const tracer = () => trace.getTracer("@databricks/appkit-agent-tracing");

interface ActiveModelStep {
  event: AgentModelStartEvent;
  span: Span;
}

export function resolveAgentTraceAppName(appName?: string): string {
  return (
    nonEmpty(appName) ??
    nonEmpty(process.env.DATABRICKS_APP_NAME) ??
    activeServiceName() ??
    nonEmpty(process.env.OTEL_SERVICE_NAME) ??
    "databricks-app"
  );
}

export async function runWithAgentTrace<T>(
  identity: AgentTraceIdentity,
  inputs: unknown,
  operation: (observer: AgentTraceObserver) => Promise<T>,
): Promise<AgentTraceResult<T>> {
  return tracer().startActiveSpan(
    `${identity.agentName} agent`,
    {
      attributes: {
        "mlflow.spanType": "AGENT",
        "mlflow.trace.session": identity.sessionId,
        "mlflow.trace.user": identity.userId,
        "appkit.app.name": resolveAgentTraceAppName(identity.appName),
        "appkit.request.id": identity.requestId,
        "appkit.thread.id": identity.threadId,
        "appkit.agent.name": identity.agentName,
        "appkit.route": identity.route,
      },
    },
    async (root) => {
      setCapturedAttribute(root, "mlflow.spanInputs", inputs);
      const rootSpanContext = root.spanContext();
      const hasValidRootContext = isSpanContextValid(rootSpanContext);
      const otelTraceId = hasValidRootContext
        ? rootSpanContext.traceId
        : randomUUID().replaceAll("-", "");
      const rootContext = trace.setSpan(
        context.active(),
        hasValidRootContext
          ? root
          : trace.wrapSpanContext({
              traceId: otelTraceId,
              spanId: randomUUID().replaceAll("-", "").slice(0, 16),
              traceFlags: 0,
            }),
      );
      const traceId = getMlflowUcTraceId(otelTraceId) ?? otelTraceId;
      const usage = new AgentUsageAccumulator();
      const activeModels = new Map<string, ActiveModelStep>();
      const completedModels = new Set<string>();
      let outputText = "";
      let lifecycleError = false;

      const observer: AgentTraceObserver = {
        traceId,
        onEvent(event) {
          if (event.type === "message_delta") {
            outputText += event.content;
            return;
          }
          if (event.type === "message") {
            outputText = event.content;
            return;
          }
          if (event.type === "model_start") {
            if (
              activeModels.has(event.stepId) ||
              completedModels.has(event.stepId)
            ) {
              return;
            }
            const span = tracer().startSpan(
              `${event.provider} ${event.model}`,
              {
                startTime: event.startedAt,
                attributes: modelStartAttributes(event),
              },
              rootContext,
            );
            setCapturedAttribute(span, "mlflow.spanInputs", event.input);
            activeModels.set(event.stepId, { event, span });
            return;
          }
          if (event.type === "model_end") {
            if (completedModels.has(event.stepId)) return;
            completedModels.add(event.stepId);
            usage.add(event.usage);
            const active = activeModels.get(event.stepId);
            activeModels.delete(event.stepId);
            if (event.error) lifecycleError = true;
            if (active) finalizeModelSpan(active, event);
            return;
          }
          if (event.type === "status" && event.status === "error") {
            lifecycleError = true;
          }
        },
      };

      let value!: T;
      let operationError: unknown;
      let failed = false;
      try {
        value = await context.with(rootContext, () => operation(observer));
      } catch (error) {
        failed = true;
        operationError = error;
        recordSafeException(root, error, "Agent operation failed");
      } finally {
        if (activeModels.size > 0) {
          lifecycleError = true;
          const endedAt = Date.now();
          for (const active of activeModels.values()) {
            completedModels.add(active.event.stepId);
            const incompleteUsage: AgentUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costAvailable: false,
            };
            usage.add(incompleteUsage);
            finalizeModelSpan(active, {
              type: "model_end",
              stepId: active.event.stepId,
              model: active.event.model,
              provider: active.event.provider,
              output: { text: outputText },
              usage: incompleteUsage,
              finishReason: failed ? "error" : "incomplete",
              streamDurationMs: Math.max(0, endedAt - active.event.startedAt),
              endedAt,
              error: failed
                ? "Agent operation failed before model completion"
                : "Model lifecycle ended without model_end",
            });
          }
          activeModels.clear();
        }

        if (lifecycleError && !failed) {
          recordSafeException(
            root,
            "Agent lifecycle reported an error",
            "Agent operation failed",
          );
        }

        const finalUsage = usage.snapshot();
        setRootUsageAttributes(root, finalUsage);
        const finalOutputText = outputText || textFromValue(value);
        setCapturedAttribute(
          root,
          "mlflow.spanOutputs",
          failed
            ? { text: finalOutputText, error: errorValue(operationError) }
            : { text: finalOutputText },
          failed ? ["error"] : undefined,
        );
        root.setStatus({
          code:
            failed || lifecycleError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          ...(failed || lifecycleError
            ? { message: "Agent operation failed" }
            : {}),
        });
        root.end();
      }

      if (failed) throw operationError;
      return { value, traceId, usage: usage.snapshot() };
    },
  );
}

function modelStartAttributes(event: AgentModelStartEvent) {
  return {
    "mlflow.spanType": "CHAT_MODEL",
    "mlflow.chat.model": event.model,
    "mlflow.chat.provider": event.provider,
    "gen_ai.request.model": event.model,
    "gen_ai.provider.name": event.provider,
    "appkit.model.step_id": event.stepId,
  };
}

function finalizeModelSpan(
  active: ActiveModelStep,
  event: AgentModelEndEvent,
): void {
  const { span } = active;
  setCapturedAttribute(span, "mlflow.spanOutputs", event.output);
  span.setAttribute(
    "mlflow.chat.tokenUsage",
    captureTraceValue(mlflowTokenUsage(event.usage)).value,
  );
  span.setAttribute("gen_ai.usage.input_tokens", event.usage.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", event.usage.outputTokens);
  if (event.usage.cacheReadInputTokens !== undefined) {
    span.setAttribute(
      "appkit.cache.read_input_tokens",
      event.usage.cacheReadInputTokens,
    );
  }
  if (event.usage.cacheCreationInputTokens !== undefined) {
    span.setAttribute(
      "appkit.cache.creation_input_tokens",
      event.usage.cacheCreationInputTokens,
    );
  }
  if (event.finishReason) {
    span.setAttribute("gen_ai.response.finish_reasons", [event.finishReason]);
  }
  if (event.firstTokenAt !== undefined) {
    span.setAttribute(
      "appkit.first_token.duration_ms",
      Math.max(0, event.firstTokenAt - active.event.startedAt),
    );
  }
  span.setAttribute("appkit.stream.duration_ms", event.streamDurationMs);
  setCostAttributes(span, event.usage);
  if (event.error) {
    recordSafeException(span, event.error, "Model operation failed");
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: "Model operation failed",
    });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end(event.endedAt);
}

function setRootUsageAttributes(span: Span, usage: AgentUsage): void {
  span.setAttribute(
    "mlflow.trace.tokenUsage",
    captureTraceValue(mlflowTokenUsage(usage)).value,
  );
  setCostAttributes(span, usage);
}

function setCostAttributes(span: Span, usage: AgentUsage): void {
  span.setAttribute("appkit.cost.available", usage.costAvailable);
  if (usage.costAvailable && usage.costUsd !== undefined) {
    span.setAttribute("mlflow.llm.cost", usage.costUsd);
  }
}

function mlflowTokenUsage(usage: AgentUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
  };
}

function setCapturedAttribute(
  span: Span,
  key: string,
  value: unknown,
  redactKeys?: readonly string[],
): void {
  const captured = captureTraceValue(value, { redactKeys });
  span.setAttribute(key, captured.value);
  span.setAttribute(`${key}.original_bytes`, captured.originalBytes);
  span.setAttribute(`${key}.sha256`, captured.sha256);
  span.setAttribute(`${key}.truncated`, captured.truncated);
}

function recordSafeException(
  span: Span,
  error: unknown,
  publicMessage: string,
): void {
  span.setAttribute(
    "appkit.error",
    captureTraceValue({ error: errorValue(error) }, { redactKeys: ["error"] })
      .value,
  );
  span.recordException({
    name: error instanceof Error ? error.name : "Error",
    message: publicMessage,
  });
}

function errorValue(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function activeServiceName(): string | undefined {
  const active = trace.getActiveSpan() as
    | (Span & { resource?: { attributes?: Record<string, unknown> } })
    | undefined;
  const value = active?.resource?.attributes?.["service.name"];
  return typeof value === "string" ? nonEmpty(value) : undefined;
}
