import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentAdapter } from "shared";
import { z } from "zod";
import { createAgent } from "../../../../packages/appkit/src/core/agent/create-agent";
import { runAgent } from "../../../../packages/appkit/src/core/agent/run-agent";
import { tool } from "../../../../packages/appkit/src/core/agent/tools/tool";

export interface SmartDashboardSpanFixture {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  spanType: string;
  agentName?: string;
  toolName?: string;
}

export interface SmartDashboardWireEvent {
  type: string;
  data?: { threadId: string; traceId: string; traceUrl?: string };
  delta?: string;
  response?: Record<string, never>;
}

export interface SmartDashboardTracingFixture {
  traceId: string;
  spans: SmartDashboardSpanFixture[];
  events: SmartDashboardWireEvent[];
}

export async function runSmartDashboardTracingFixture(options?: {
  includeTraceUrl?: boolean;
}): Promise<SmartDashboardTracingFixture> {
  context.disable();
  trace.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  try {
    const filterByDateRange = tool({
      name: "filter_by_date_range",
      description: "Filter the dashboard to a date range",
      schema: z.object({ start: z.string(), end: z.string() }),
      execute: async ({ start, end }) => `Filtered ${start} through ${end}.`,
    });
    const pilotAdapter: AgentAdapter = {
      async *run(_input, runContext) {
        const result = await runContext.executeTool("filter_by_date_range", {
          start: "2016-11-01",
          end: "2016-11-30",
        });
        yield { type: "message_delta", content: String(result) };
      },
    };
    const queryAdapter: AgentAdapter = {
      async *run(_input, runContext) {
        const result = await runContext.executeTool("agent-dashboard_pilot", {
          input: "Show November 2016",
        });
        yield { type: "message_delta", content: String(result) };
      },
    };
    const query = createAgent({
      name: "query",
      instructions: "Delegate dashboard changes to the dashboard pilot.",
      model: queryAdapter,
      agents: {
        dashboard_pilot: createAgent({
          name: "dashboard_pilot",
          instructions: "Manipulate the Smart Dashboard.",
          model: pilotAdapter,
          tools: { filter_by_date_range: filterByDateRange },
        }),
      },
    });

    const result = await runAgent(query, {
      appName: "dev-playground",
      messages: "Show November 2016",
      requestId: "smart-dashboard-request",
      sessionId: "smart-dashboard-session",
      threadId: "smart-dashboard-thread",
      userId: "fixture-user",
    });
    await provider.forceFlush();

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => {
        const spanType = span.attributes["mlflow.spanType"];
        return spanType === "AGENT" || spanType === "TOOL";
      })
      .map((span) => ({
        spanId: span.spanContext().spanId,
        ...(span.parentSpanContext?.spanId
          ? { parentSpanId: span.parentSpanContext.spanId }
          : {}),
        traceId: span.spanContext().traceId,
        spanType: String(span.attributes["mlflow.spanType"]),
        ...(typeof span.attributes["appkit.agent.name"] === "string"
          ? { agentName: span.attributes["appkit.agent.name"] }
          : {}),
        ...(typeof span.attributes["appkit.tool.name"] === "string"
          ? { toolName: span.attributes["appkit.tool.name"] }
          : {}),
      }));
    const traceUrl = options?.includeTraceUrl
      ? `https://example.cloud.databricks.com/ml/experiments/123456789/traces?selectedTraceId=${encodeURIComponent(result.traceId)}`
      : undefined;

    return {
      traceId: result.traceId,
      spans,
      events: [
        {
          type: "appkit.metadata",
          data: {
            threadId: "smart-dashboard-thread",
            traceId: result.traceId,
            ...(traceUrl ? { traceUrl } : {}),
          },
        },
        {
          type: "response.output_text.delta",
          delta: "Applied the November filter.",
        },
        { type: "response.completed", response: {} },
      ],
    };
  } finally {
    await provider.shutdown();
    trace.disable();
    context.disable();
  }
}
