import { randomUUID } from "node:crypto";
import {
  context,
  createContextKey,
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
import { attachRemoteTraceLink, remoteOtelTraceId } from "./propagation";
import { captureTraceValue, normalizeFailureOutput } from "./serialization";
import type {
  AgentTraceIdentity,
  AgentTraceObserver,
  AgentTraceResult,
} from "./types";
import { AgentUsageAccumulator } from "./usage";

const tracer = () => trace.getTracer("@databricks/appkit-agent-tracing");
const ACTIVE_AGENT_TRACE_IDENTITY = createContextKey(
  "@databricks/appkit-agent-trace-identity",
);

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

export function getActiveAgentTraceIdentity(): AgentTraceIdentity | undefined {
  const identity = context.active().getValue(ACTIVE_AGENT_TRACE_IDENTITY) as
    | AgentTraceIdentity
    | undefined;
  return identity ? { ...identity } : undefined;
}

export async function runWithAgentTrace<T>(
  identity: AgentTraceIdentity,
  inputs: unknown,
  operation: (observer: AgentTraceObserver) => Promise<T>,
  onCompleteUsage?: (usage: AgentUsage) => void,
): Promise<AgentTraceResult<T>> {
  const activeIdentity: AgentTraceIdentity = {
    ...identity,
    appName: resolveAgentTraceAppName(identity.appName),
  };
  return tracer().startActiveSpan(
    `${identity.agentName} agent`,
    {
      attributes: {
        "mlflow.spanType": "AGENT",
        "mlflow.trace.session": activeIdentity.sessionId,
        "mlflow.trace.user": activeIdentity.userId,
        "appkit.app.name": activeIdentity.appName,
        "appkit.request.id": activeIdentity.requestId,
        "appkit.thread.id": activeIdentity.threadId,
        "appkit.agent.name": activeIdentity.agentName,
        "appkit.route": activeIdentity.route,
      },
    },
    async (root) => {
      setCapturedAttribute(root, "mlflow.spanInputs", inputs);
      const rootSpanContext = root.spanContext();
      const hasValidRootContext = isSpanContextValid(rootSpanContext);
      const otelTraceId = hasValidRootContext
        ? rootSpanContext.traceId
        : randomUUID().replaceAll("-", "");
      const rootContext = trace
        .setSpan(
          context.active(),
          hasValidRootContext
            ? root
            : trace.wrapSpanContext({
                traceId: otelTraceId,
                spanId: randomUUID().replaceAll("-", "").slice(0, 16),
                traceFlags: 0,
              }),
        )
        .setValue(ACTIVE_AGENT_TRACE_IDENTITY, activeIdentity);
      const traceId = getMlflowUcTraceId(otelTraceId) ?? otelTraceId;
      const usage = new AgentUsageAccumulator();
      const activeModels = new Map<string, ActiveModelStep>();
      const completedModels = new Set<string>();
      let outputText = "";
      let lifecycleError = false;
      let reportedError: unknown;
      let explicitOutput: unknown;
      let hasExplicitOutput = false;

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
            const normalizedUsage = normalizeUsage(event.usage);
            usage.add(normalizedUsage);
            const active = activeModels.get(event.stepId);
            activeModels.delete(event.stepId);
            if (event.error) {
              lifecycleError = true;
              reportedError ??= event.error;
            }
            if (active) {
              finalizeModelSpan(active, {
                ...event,
                usage: normalizedUsage,
              });
            }
            return;
          }
          if (event.type === "remote_trace") {
            const active = [...activeModels.values()].at(-1);
            if (!active) return;
            const otelTraceId = remoteOtelTraceId(event.traceId);
            if (event.relation === "linked" && otelTraceId && event.spanId) {
              attachRemoteTraceLink(active.span, {
                traceId: event.traceId,
                otelTraceId,
                spanId: event.spanId,
                source: event.source,
              });
            }
            return;
          }
          if (event.type === "status" && event.status === "error") {
            lifecycleError = true;
            reportedError ??= event.error;
          }
        },
        addChildUsage(childUsage) {
          usage.add(normalizeUsage(childUsage));
        },
        updateIdentity(next) {
          updateActiveIdentity(activeIdentity, next);
          setIdentityAttributes(root, next);
        },
        setOutput(output) {
          explicitOutput = output;
          hasExplicitOutput = true;
        },
        recordError(error, output) {
          lifecycleError = true;
          reportedError ??= error;
          if (output !== undefined) {
            explicitOutput = output;
            hasExplicitOutput = true;
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
            reportedError ?? "Agent lifecycle reported an error",
            "Agent operation failed",
          );
        }

        const finalUsage = usage.snapshot();
        setRootUsageAttributes(root, finalUsage);
        onCompleteUsage?.(finalUsage);
        const finalOutputText = outputText || textFromValue(value);
        const finalOutput =
          failed || lifecycleError
            ? normalizeFailureOutput(
                hasExplicitOutput ? explicitOutput : finalOutputText,
                operationError ?? reportedError,
              )
            : hasExplicitOutput
              ? explicitOutput
              : outputText || textFromValue(value)
                ? { text: finalOutputText }
                : value;
        setCapturedAttribute(
          root,
          "mlflow.spanOutputs",
          finalOutput,
          failed || lifecycleError ? ["error"] : undefined,
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

function updateActiveIdentity(
  identity: AgentTraceIdentity,
  next: Partial<Omit<AgentTraceIdentity, "route">>,
): void {
  Object.assign(identity, next);
  if (next.appName !== undefined) {
    identity.appName = resolveAgentTraceAppName(next.appName);
  }
}

function modelStartAttributes(event: AgentModelStartEvent) {
  return {
    "mlflow.spanType": "CHAT_MODEL",
    "gen_ai.operation.name": "chat",
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
  setCapturedAttribute(
    span,
    "mlflow.spanOutputs",
    event.error
      ? normalizeFailureOutput(event.output, event.error)
      : event.output,
    event.error ? ["error"] : undefined,
  );
  span.setAttribute(
    "mlflow.chat.tokenUsage",
    captureTraceValue(mlflowTokenUsage(event.usage)).value,
  );
  span.setAttribute("gen_ai.usage.input_tokens", event.usage.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", event.usage.outputTokens);
  if (event.usage.cacheReadInputTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_read_input_tokens",
      event.usage.cacheReadInputTokens,
    );
    span.setAttribute(
      "appkit.cache.read_input_tokens",
      event.usage.cacheReadInputTokens,
    );
  }
  if (event.usage.cacheCreationInputTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_creation_input_tokens",
      event.usage.cacheCreationInputTokens,
    );
    span.setAttribute(
      "appkit.cache.creation_input_tokens",
      event.usage.cacheCreationInputTokens,
    );
  }
  if (event.finishReason) {
    span.setAttribute("gen_ai.response.finish_reasons", [event.finishReason]);
  }
  span.setAttribute("gen_ai.response.model", event.model);
  if (event.firstTokenAt !== undefined) {
    span.setAttribute(
      "gen_ai.response.time_to_first_token_ms",
      Math.max(0, event.firstTokenAt - active.event.startedAt),
    );
    span.setAttribute(
      "appkit.first_token.duration_ms",
      Math.max(0, event.firstTokenAt - active.event.startedAt),
    );
  }
  span.setAttribute(
    "gen_ai.response.stream_duration_ms",
    event.streamDurationMs,
  );
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
  const costAvailable = hasCompleteCost(usage);
  span.setAttribute("appkit.cost.available", costAvailable);
  if (costAvailable && usage.costUsd !== undefined) {
    span.setAttribute("mlflow.llm.cost", usage.costUsd);
  }
}

function normalizeUsage(usage: AgentUsage): AgentUsage {
  const { costUsd, ...withoutCost } = usage;
  const costAvailable = hasCompleteCost(usage);
  return {
    ...withoutCost,
    ...(costAvailable ? { costUsd } : {}),
    costAvailable,
  };
}

function hasCompleteCost(usage: AgentUsage): boolean {
  return (
    usage.costAvailable &&
    typeof usage.costUsd === "number" &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
  );
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
    name: "Error",
    message: publicMessage,
  });
}

function setIdentityAttributes(
  span: Span,
  identity: Partial<Omit<AgentTraceIdentity, "route">>,
): void {
  if (identity.appName !== undefined) {
    span.setAttribute(
      "appkit.app.name",
      resolveAgentTraceAppName(identity.appName),
    );
  }
  if (identity.agentName !== undefined) {
    span.setAttribute("appkit.agent.name", identity.agentName);
  }
  if (identity.sessionId !== undefined) {
    span.setAttribute("mlflow.trace.session", identity.sessionId);
  }
  if (identity.userId !== undefined) {
    span.setAttribute("mlflow.trace.user", identity.userId);
  }
  if (identity.requestId !== undefined) {
    span.setAttribute("appkit.request.id", identity.requestId);
  }
  if (identity.threadId !== undefined) {
    span.setAttribute("appkit.thread.id", identity.threadId);
  }
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
