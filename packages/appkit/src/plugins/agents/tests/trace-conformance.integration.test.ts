import { execFileSync } from "node:child_process";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentAdapter, AgentInput, AgentRunContext } from "shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../../core/agent/create-agent";
import { runAgent } from "../../../core/agent/run-agent";
import { tool } from "../../../core/agent/tools/tool";

interface SpanManifest {
  name: string;
  spanType: string;
  spanId: string;
  parentSpanId: string | null;
  inputs: unknown;
  outputs: unknown;
  status: number;
  latencyMs: number;
  model?: string;
  provider?: string;
  usage: Record<string, number>;
  costUsd?: number;
  costAvailable: boolean;
  links: Array<{ traceId: string; spanId: string }>;
  attributes: Record<string, unknown>;
}

interface TraceManifest {
  template: string;
  traceId: string;
  spans: SpanManifest[];
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = decoded(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function normalize(template: string, spans: ReadableSpan[]): TraceManifest {
  const traceIds = new Set(spans.map((span) => span.spanContext().traceId));
  expect(traceIds.size, `${template}: mixed trace IDs`).toBe(1);
  return {
    template,
    traceId: [...traceIds][0],
    spans: spans.map((span) => {
      const attributes = { ...span.attributes };
      const usage = objectValue(
        attributes[
          span.attributes["mlflow.spanType"] === "AGENT"
            ? "mlflow.trace.tokenUsage"
            : "mlflow.chat.tokenUsage"
        ],
      ) as Record<string, number>;
      return {
        name: span.name,
        spanType: String(attributes["mlflow.spanType"] ?? ""),
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId ?? null,
        inputs: decoded(attributes["mlflow.spanInputs"]),
        outputs: decoded(attributes["mlflow.spanOutputs"]),
        status: span.status.code,
        latencyMs: span.duration[0] * 1_000 + span.duration[1] / 1_000_000,
        model: attributes["mlflow.chat.model"] as string | undefined,
        provider: attributes["mlflow.chat.provider"] as string | undefined,
        usage,
        costUsd: attributes["mlflow.llm.cost"] as number | undefined,
        costAvailable: attributes["appkit.cost.available"] === true,
        links: span.links.map((link) => ({
          traceId: link.context.traceId,
          spanId: link.context.spanId,
        })),
        attributes,
      };
    }),
  };
}

function assertContract(manifest: TraceManifest): void {
  const roots = manifest.spans.filter((span) => span.parentSpanId === null);
  expect(roots, `${manifest.template}: AGENT roots`).toHaveLength(1);
  const root = roots[0];
  expect(root.spanType, `${manifest.template}/${root.name}: span type`).toBe(
    "AGENT",
  );
  const ids = new Set(manifest.spans.map((span) => span.spanId));
  const models = manifest.spans.filter(
    (span) => span.spanType === "CHAT_MODEL",
  );
  const tools = manifest.spans.filter((span) => span.spanType === "TOOL");
  expect(models.length, `${manifest.template}: model children`).toBeGreaterThan(
    0,
  );
  expect(tools.length, `${manifest.template}: tool children`).toBeGreaterThan(
    0,
  );
  for (const span of manifest.spans) {
    expect(
      span.inputs,
      `${manifest.template}/${span.name}: inputs`,
    ).toBeDefined();
    expect(
      span.outputs,
      `${manifest.template}/${span.name}: outputs`,
    ).toBeDefined();
    expect(span.status, `${manifest.template}/${span.name}: status`).not.toBe(
      0,
    );
    expect(
      span.latencyMs,
      `${manifest.template}/${span.name}: latency`,
    ).toBeGreaterThanOrEqual(0);
    if (span.parentSpanId !== null) {
      expect(
        ids.has(span.parentSpanId),
        `${manifest.template}/${span.name}: parent`,
      ).toBe(true);
    }
  }
  for (const model of models) {
    expect(
      model.model,
      `${manifest.template}/${model.name}: model`,
    ).toBeTruthy();
    expect(
      model.provider,
      `${manifest.template}/${model.name}: provider`,
    ).toBeTruthy();
    expect(
      model.usage.total_tokens,
      `${manifest.template}/${model.name}: usage`,
    ).toBe(model.usage.input_tokens + model.usage.output_tokens);
    expect(
      model.attributes["appkit.first_token.duration_ms"],
      `${manifest.template}/${model.name}: TTFT`,
    ).toEqual(expect.any(Number));
    expect(
      model.attributes["appkit.stream.duration_ms"],
      `${manifest.template}/${model.name}: stream duration`,
    ).toEqual(expect.any(Number));
    expect(
      model.costAvailable,
      `${manifest.template}/${model.name}: cost`,
    ).toBe(true);
  }
  expect(
    root.attributes,
    `${manifest.template}/${root.name}: identity`,
  ).toMatchObject({
    "appkit.app.name": manifest.template,
    "mlflow.trace.user": "user-1",
    "mlflow.trace.session": "session-1",
  });
  const aggregate = models.reduce(
    (total, span) => total + span.usage.total_tokens,
    0,
  );
  expect(
    root.usage.total_tokens,
    `${manifest.template}/${root.name}: aggregate usage`,
  ).toBe(aggregate);
  expect(
    root.costUsd,
    `${manifest.template}/${root.name}: aggregate cost`,
  ).toBe(models.reduce((total, span) => total + (span.costUsd ?? 0), 0));
}

async function captureTurn(template: string): Promise<TraceManifest> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const getTracer = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name, version) => provider.getTracer(name, version));
  const clock = tool({
    name: "clock",
    description: "Return UTC time",
    schema: z.object({ zone: z.string() }),
    execute: async () => ({ time: "12:00", zone: "UTC" }),
  });
  const adapter: AgentAdapter = {
    async *run(_input: AgentInput, runtime: AgentRunContext) {
      const startedAt = Date.now() - 10;
      yield {
        type: "model_start",
        stepId: "step-1",
        model: "test-model",
        provider: "databricks",
        input: { messages: [{ role: "user", content: "Use the clock tool" }] },
        startedAt,
      };
      const value = await runtime.executeTool("clock", { zone: "UTC" });
      yield { type: "message_delta", content: JSON.stringify(value) };
      yield {
        type: "model_end",
        stepId: "step-1",
        model: "test-model",
        provider: "databricks",
        output: value,
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          costUsd: 0.01,
          costAvailable: true,
        },
        firstTokenAt: startedAt + 2,
        streamDurationMs: 10,
        endedAt: startedAt + 10,
      };
    },
  };
  try {
    await runAgent(
      createAgent({
        name: "planner",
        instructions: "Use tools",
        model: adapter,
        tools: { clock },
      }),
      {
        messages: "Use the clock tool",
        appName: template,
        requestId: "request-1",
        sessionId: "session-1",
        threadId: "thread-1",
        userId: "user-1",
      },
    );
    await provider.forceFlush();
    return normalize(template, exporter.getFinishedSpans());
  } finally {
    getTracer.mockRestore();
    await provider.shutdown();
  }
}

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});

afterAll(() => context.disable());

describe.each(["appkit-agents", "appkit-all-in-one"])(
  "%s trace conformance",
  (template) => {
    test("writes, reloads, and validates a deterministic tool turn", async () => {
      const manifest = await captureTurn(template);
      const reloaded = JSON.parse(JSON.stringify(manifest)) as TraceManifest;
      assertContract(reloaded);
    });
  },
);

const deployedPrerequisites = [
  "APPKIT_TRACE_CONFORMANCE_URL",
  "APPKIT_TRACE_CONFORMANCE_PROFILE",
  "APPKIT_TRACE_CONFORMANCE_EXPERIMENT_ID",
  "APPKIT_TRACE_CONFORMANCE_WAREHOUSE_ID",
  "APPKIT_TRACE_CONFORMANCE_OTEL_SPANS_TABLE",
  "APPKIT_TRACE_CONFORMANCE_UC_CATALOG",
  "APPKIT_TRACE_CONFORMANCE_UC_SCHEMA",
  "APPKIT_TRACE_CONFORMANCE_UC_TABLE_PREFIX",
] as const;
const missingDeployed = deployedPrerequisites.filter(
  (name) => !process.env[name],
);

test.skipIf(missingDeployed.length > 0)(
  "deployed AppKit agent persists the returned trace at its exact UC location",
  async () => {
    const profile = process.env.APPKIT_TRACE_CONFORMANCE_PROFILE ?? "";
    const token = JSON.parse(
      execFileSync("databricks", ["auth", "token", "-p", profile], {
        encoding: "utf8",
      }),
    ).access_token;
    const response = await fetch(
      process.env.APPKIT_TRACE_CONFORMANCE_URL ?? "",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MLflow-Return-Trace-Id": "true",
        },
        body: JSON.stringify({
          input: [
            { role: "user", content: "What time is it? Use the clock tool." },
          ],
        }),
      },
    );
    expect(response.ok).toBe(true);
    const traceId = response.headers.get("x-mlflow-trace-id");
    expect(traceId).toBeTruthy();
    const experiment = JSON.parse(
      execFileSync(
        "databricks",
        [
          "api",
          "get",
          `/api/2.0/mlflow/experiments/get?experiment_id=${encodeURIComponent(process.env.APPKIT_TRACE_CONFORMANCE_EXPERIMENT_ID ?? "")}`,
          "-p",
          profile,
        ],
        { encoding: "utf8" },
      ),
    );
    const location = experiment.experiment?.trace_location;
    expect(location).toBeDefined();
    expect(JSON.stringify(location)).toContain(
      process.env.APPKIT_TRACE_CONFORMANCE_UC_CATALOG,
    );
    expect(JSON.stringify(location)).toContain(
      process.env.APPKIT_TRACE_CONFORMANCE_UC_SCHEMA,
    );
    expect(JSON.stringify(location)).toContain(
      process.env.APPKIT_TRACE_CONFORMANCE_UC_TABLE_PREFIX,
    );

    let storedTrace: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 15 && !storedTrace; attempt += 1) {
      try {
        storedTrace = JSON.parse(
          execFileSync(
            "databricks",
            [
              "api",
              "get",
              `/api/3.0/mlflow/traces/${encodeURIComponent(traceId ?? "")}`,
              "-p",
              profile,
            ],
            { encoding: "utf8" },
          ),
        );
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    expect(
      storedTrace,
      `MLflow could not retrieve trace ${traceId}`,
    ).toBeDefined();
    const statement =
      "SELECT trace_id, span_id, parent_span_id, name, attributes\n" +
      "FROM IDENTIFIER(:otel_spans_table)\n" +
      "WHERE trace_id = :trace_id\n" +
      "ORDER BY start_time_unix_nano";
    const sql = JSON.parse(
      execFileSync(
        "databricks",
        [
          "api",
          "post",
          "/api/2.0/sql/statements",
          "-p",
          profile,
          "--json",
          JSON.stringify({
            warehouse_id: process.env.APPKIT_TRACE_CONFORMANCE_WAREHOUSE_ID,
            statement,
            wait_timeout: "50s",
            parameters: [
              {
                name: "otel_spans_table",
                type: "STRING",
                value: process.env.APPKIT_TRACE_CONFORMANCE_OTEL_SPANS_TABLE,
              },
              { name: "trace_id", type: "STRING", value: traceId },
            ],
          }),
        ],
        { encoding: "utf8" },
      ),
    );
    expect(sql.status?.state).toBe("SUCCEEDED");
    expect(sql.result?.data_array?.length).toBeGreaterThan(0);
    const traceRecord = (storedTrace?.trace ?? storedTrace) as {
      info?: { trace_id?: string; traceId?: string };
      data?: { spans?: Array<Record<string, unknown>> };
    };
    const storedSpans = traceRecord.data?.spans ?? [];
    const rows = (sql.result.data_array as unknown[][]).map((row) => ({
      traceId: row[0],
      spanId: row[1],
      parentSpanId: row[2],
      name: row[3],
      attributes: objectValue(row[4]),
    }));
    expect(new Set(rows.map((row) => row.traceId))).toEqual(new Set([traceId]));
    const persistedManifest: TraceManifest = {
      template: "appkit-agents",
      traceId: String(traceRecord.info?.trace_id ?? traceRecord.info?.traceId),
      spans: rows.map((row) => {
        const source = storedSpans.find(
          (span) => (span.span_id ?? span.spanId) === row.spanId,
        );
        expect(
          source,
          `UC span ${String(row.spanId)} missing from MLflow`,
        ).toBeDefined();
        const attributes = row.attributes;
        const spanType = String(attributes["mlflow.spanType"] ?? "");
        const usage = objectValue(
          attributes[
            spanType === "AGENT"
              ? "mlflow.trace.tokenUsage"
              : "mlflow.chat.tokenUsage"
          ],
        ) as Record<string, number>;
        return {
          name: String(row.name),
          spanType,
          spanId: String(row.spanId),
          parentSpanId: row.parentSpanId ? String(row.parentSpanId) : null,
          inputs: decoded(attributes["mlflow.spanInputs"]),
          outputs: decoded(attributes["mlflow.spanOutputs"]),
          status: Number(
            (source?.status as { code?: number } | undefined)?.code ?? 0,
          ),
          latencyMs: Number(source?.latency_ms ?? source?.latencyMs ?? -1),
          model: attributes["mlflow.chat.model"] as string | undefined,
          provider: attributes["mlflow.chat.provider"] as string | undefined,
          usage,
          costUsd: attributes["mlflow.llm.cost"] as number | undefined,
          costAvailable: attributes["appkit.cost.available"] === true,
          links: [],
          attributes,
        };
      }),
    };
    assertContract(persistedManifest);
  },
  180_000,
);
