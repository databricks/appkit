import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import type { AgentDefinition } from "../../../core/agent/types";

const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const generatedApps = mkdtempSync(
  join(repositoryRoot, ".trace-conformance-generated-"),
);

interface SpanManifest {
  name: string;
  spanType: string;
  spanId: string;
  parentSpanId: string | null;
  inputs: unknown;
  outputs: unknown;
  status: string | number;
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
      const firstToken =
        attributes.ttft_ms ??
        attributes["appkit.ttft_ms"] ??
        attributes["appkit.first_token.duration_ms"] ??
        attributes["gen_ai.latency.time_to_first_token_ms"];
      const streamDuration =
        attributes.stream_duration_ms ??
        attributes["appkit.stream_duration_ms"] ??
        attributes["appkit.stream.duration_ms"] ??
        attributes["gen_ai.latency.stream_ms"];
      if (firstToken !== undefined) attributes.ttft_ms = firstToken;
      if (streamDuration !== undefined) {
        attributes.stream_duration_ms = streamDuration;
      }
      if (firstToken !== undefined || streamDuration !== undefined) {
        attributes.streaming = true;
      }
      attributes.app_id ??=
        attributes["app.id"] ?? attributes["appkit.app.name"];
      attributes.user_id ??=
        attributes["user.id"] ?? attributes["mlflow.trace.user"];
      attributes.session_id ??=
        attributes["session.id"] ?? attributes["mlflow.trace.session"];
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
  const fail = (
    span: SpanManifest | undefined,
    field: string,
    detail: string,
  ): never => {
    throw new Error(
      `template=${manifest.template || "<unknown>"} span=${span?.name ?? "<trace>"} field=${field}: ${detail}`,
    );
  };
  const hasValue = (value: unknown) =>
    value !== undefined &&
    value !== null &&
    value !== "" &&
    !(Array.isArray(value) && value.length === 0) &&
    !(
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  const terminalStatus = (status: string | number) =>
    status === 1 ? "OK" : status === 2 ? "ERROR" : String(status).toUpperCase();
  const usageFields = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
  ] as const;
  const assertUsage = (span: SpanManifest) => {
    for (const field of usageFields) {
      const value = span.usage[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(span, `usage.${field}`, "must be a non-negative number");
      }
    }
    if (
      span.usage.total_tokens <
      Math.max(span.usage.input_tokens, span.usage.output_tokens)
    ) {
      fail(span, "usage.total_tokens", "is smaller than a component");
    }
  };
  const assertCost = (span: SpanManifest) => {
    if (typeof span.costAvailable !== "boolean") {
      fail(span, "cost_available", "must explicitly be true or false");
    }
    if (span.costAvailable) {
      if (
        typeof span.costUsd !== "number" ||
        !Number.isFinite(span.costUsd) ||
        span.costUsd < 0
      ) {
        fail(span, "cost_usd", "available cost must be non-negative");
      }
    } else if (span.costUsd !== undefined) {
      fail(span, "cost_usd", "unavailable cost must not be reported as zero");
    }
  };
  const secretKeys = new Set([
    "accesstoken",
    "apikey",
    "authorization",
    "clientsecret",
    "cookie",
    "credential",
    "credentials",
    "databrickstoken",
    "password",
    "refreshtoken",
    "secret",
    "setcookie",
    "token",
    "xapikey",
  ]);
  const assertRedacted = (span: SpanManifest, value: unknown): void => {
    if (Array.isArray(value)) {
      for (const nested of value) assertRedacted(span, nested);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        if (
          secretKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) &&
          nested !== "[REDACTED]"
        ) {
          fail(span, "credentials", `${key} is not redacted`);
        }
        assertRedacted(span, nested);
      }
      return;
    }
    if (
      typeof value === "string" &&
      /\b(?:authorization|api[ _-]?key|password|secret|token|credentials?)\b\s*(?::|=|is)?\s+(?!\[REDACTED\])(?:Bearer\s+)?[^\s,;}]+/i.test(
        value,
      )
    ) {
      fail(span, "credentials", "captured text contains an unredacted secret");
    }
  };
  if (!manifest.template) fail(undefined, "template", "missing template");
  if (!manifest.traceId) fail(undefined, "trace_id", "missing trace identity");
  if (manifest.spans.length === 0)
    fail(undefined, "spans", "trace has no spans");
  const roots = manifest.spans.filter((span) => span.parentSpanId === null);
  if (roots.length !== 1 || roots[0]?.spanType !== "AGENT") {
    fail(
      roots.at(-1) ?? manifest.spans[0],
      "AGENT root",
      "trace must have exactly one parentless AGENT",
    );
  }
  const root = roots[0];
  const supportedTypes = new Set([
    "AGENT",
    "CHAIN",
    "CHAT_MODEL",
    "EMBEDDING",
    "LLM",
    "MEMORY",
    "PARSER",
    "RETRIEVER",
    "TOOL",
  ]);
  const spansById = new Map<string, SpanManifest>();
  for (const span of manifest.spans) {
    if (!span.name) fail(span, "name", "missing span name");
    if (!supportedTypes.has(span.spanType)) {
      fail(span, "span_type", `unsupported semantic type ${span.spanType}`);
    }
    if (!span.spanId) fail(span, "span_id", "missing span identity");
    if (spansById.has(span.spanId)) {
      fail(span, "span_id", `duplicate span identity ${span.spanId}`);
    }
    spansById.set(span.spanId, span);
  }
  const models = manifest.spans.filter(
    (span) => span.spanType === "CHAT_MODEL" || span.spanType === "LLM",
  );
  if (models.length === 0)
    fail(root, "semantic child", "trace has no model child");
  for (const span of manifest.spans) {
    if (!hasValue(span.inputs))
      fail(span, "inputs", "captured inputs are missing");
    if (!hasValue(span.outputs))
      fail(span, "outputs", "captured outputs are missing");
    const status = terminalStatus(span.status);
    if (!new Set(["OK", "SUCCESS", "ERROR", "CANCELLED"]).has(status)) {
      fail(span, "status", "span is not finalized with a terminal status");
    }
    if (
      typeof span.latencyMs !== "number" ||
      !Number.isFinite(span.latencyMs) ||
      span.latencyMs < 0
    ) {
      fail(span, "latency_ms", "missing or invalid latency");
    }
    if (
      status === "ERROR" &&
      !(
        typeof span.outputs === "object" &&
        span.outputs !== null &&
        hasValue((span.outputs as Record<string, unknown>).partial_output)
      )
    ) {
      fail(
        span,
        "outputs.partial_output",
        "failed span must retain partial_output",
      );
    }
    assertCost(span);
    assertRedacted(span, span.inputs);
    assertRedacted(span, span.outputs);
    assertRedacted(span, span.attributes);
    if (span.parentSpanId !== null) {
      if (!spansById.has(span.parentSpanId)) {
        fail(span, "parent_span_id", `orphan parent ${span.parentSpanId}`);
      }
    }
    const remoteTraceId = span.attributes.remote_trace_id;
    if (remoteTraceId) {
      const remoteSpanId = span.attributes.remote_span_id;
      if (!remoteSpanId) fail(span, "remote_span_id", "remote root is missing");
      if (span.attributes.remote_lifecycle_complete !== true) {
        fail(
          span,
          "remote_lifecycle_complete",
          "remote lifecycle is incomplete",
        );
      }
      if (
        remoteTraceId !== manifest.traceId &&
        !span.links.some(
          (link) =>
            link.traceId === remoteTraceId && link.spanId === remoteSpanId,
        )
      ) {
        fail(
          span,
          "links",
          "orphan remote trace is neither continued nor linked",
        );
      }
    }
  }
  for (const span of manifest.spans) {
    const ancestry = new Set<string>();
    let current = span;
    while (current.parentSpanId !== null) {
      if (ancestry.has(current.spanId)) {
        fail(span, "parent_span_id", "parent ancestry contains a cycle");
      }
      ancestry.add(current.spanId);
      current =
        spansById.get(current.parentSpanId) ??
        fail(span, "parent_span_id", "span has an orphan parent");
    }
  }
  for (const model of models) {
    if (!model.model) fail(model, "model", "model identity is missing");
    if (!model.provider)
      fail(model, "provider", "provider identity is missing");
    assertUsage(model);
    if (model.attributes.streaming === true) {
      for (const field of ["ttft_ms", "stream_duration_ms"] as const) {
        const value = model.attributes[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          fail(model, field, "stream timing is missing or invalid");
        }
      }
    }
  }
  for (const field of ["app_id", "user_id", "session_id"] as const) {
    if (!hasValue(root.attributes[field])) {
      fail(root, field, "request identity is missing");
    }
  }
  assertUsage(root);
  for (const field of usageFields) {
    const expected = models.reduce(
      (total, span) => total + span.usage[field],
      0,
    );
    if (root.usage[field] !== expected) {
      fail(
        root,
        `usage.${field}`,
        `aggregate does not equal descendant total ${expected}`,
      );
    }
  }
  const costAvailable = models.every((span) => span.costAvailable);
  if (root.costAvailable !== costAvailable) {
    fail(root, "cost_available", "does not match descendant availability");
  }
  if (costAvailable) {
    const expected = models.reduce(
      (total, span) => total + (span.costUsd ?? 0),
      0,
    );
    if (Math.abs((root.costUsd ?? Number.NaN) - expected) > 1e-12) {
      fail(root, "cost_usd", "does not equal descendant cost total");
    }
  }
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

async function captureGeneratedTurn(template: string): Promise<TraceManifest> {
  const helperPath = join(generatedApps, template, "server/agents/helper.ts");
  const generated = (await import(pathToFileURL(helperPath).href)) as {
    helper: AgentDefinition;
  };
  const adapter: AgentAdapter = {
    async *run(_input: AgentInput, runtime: AgentRunContext) {
      const startedAt = Date.now() - 10;
      yield {
        type: "model_start",
        stepId: "generated-step",
        model: "generated-test-model",
        provider: "databricks",
        input: { messages: [{ role: "user", content: "Use count_words" }] },
        startedAt,
      };
      const value = await runtime.executeTool("count_words", {
        text: "hello traced world",
      });
      yield { type: "message_delta", content: JSON.stringify(value) };
      yield {
        type: "model_end",
        stepId: "generated-step",
        model: "generated-test-model",
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
  generated.helper.model = adapter;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const getTracer = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name, version) => provider.getTracer(name, version));
  try {
    await runAgent(generated.helper, {
      messages: "Count the words in hello traced world. Use count_words.",
      appName: template,
      requestId: "request-1",
      sessionId: "session-1",
      threadId: "thread-1",
      userId: "user-1",
    });
    await provider.forceFlush();
    return normalize(template, exporter.getFinishedSpans());
  } finally {
    getTracer.mockRestore();
    await provider.shutdown();
  }
}

beforeAll(() => {
  const compatibleCli = "/tmp/databricks-cli-1.11.0/databricks";
  execFileSync("pnpm", ["generate:app-templates"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      APP_TEMPLATES_OUTPUT_DIR: generatedApps,
      ...(process.env.DATABRICKS_CLI
        ? {}
        : existsSync(compatibleCli)
          ? { DATABRICKS_CLI: compatibleCli }
          : {}),
    },
    stdio: "pipe",
  });
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});

afterAll(() => {
  context.disable();
  rmSync(generatedApps, { recursive: true, force: true });
});

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

describe.each(["appkit-agents", "appkit-all-in-one"])(
  "%s generated production package",
  (template) => {
    test("invokes its own generated agent definition and validates the trace", async () => {
      const manifest = await captureGeneratedTurn(template);
      expect(
        manifest.spans.some(
          (span) =>
            span.spanType === "TOOL" && span.name === "count_words tool",
        ),
        JSON.stringify(
          manifest.spans.map((span) => [span.spanType, span.name]),
        ),
      ).toBe(true);
      assertContract(manifest);
    });
  },
);

function requiredSpan(manifest: TraceManifest, spanType: string): SpanManifest {
  const span = manifest.spans.find(
    (candidate) => candidate.spanType === spanType,
  );
  if (!span) throw new Error(`fixture is missing ${spanType}`);
  return span;
}

test.each([
  {
    name: "duplicate span identity",
    mutate(manifest: TraceManifest) {
      const model = requiredSpan(manifest, "CHAT_MODEL");
      const toolSpan = requiredSpan(manifest, "TOOL");
      toolSpan.spanId = model.spanId;
    },
    expected: /duplicate span identity/,
  },
  {
    name: "orphan parent",
    mutate(manifest: TraceManifest) {
      const toolSpan = requiredSpan(manifest, "TOOL");
      toolSpan.parentSpanId = "missing-parent";
    },
    expected: /orphan parent/,
  },
  {
    name: "parent cycle",
    mutate(manifest: TraceManifest) {
      const model = requiredSpan(manifest, "CHAT_MODEL");
      const toolSpan = requiredSpan(manifest, "TOOL");
      model.parentSpanId = toolSpan.spanId;
      toolSpan.parentSpanId = model.spanId;
    },
    expected: /cycle/,
  },
])("rejects $name", async ({ mutate, expected }) => {
  const manifest = await captureTurn("topology-fixture");
  mutate(manifest);

  expect(() => assertContract(manifest)).toThrow(expected);
});

const fixtureUsage = {
  input_tokens: 7,
  output_tokens: 3,
  total_tokens: 10,
};

function fixtureSpan(
  name: string,
  spanType: string,
  spanId: string,
  parentSpanId: string | null,
): SpanManifest {
  return {
    name,
    spanType,
    spanId,
    parentSpanId,
    inputs: { value: "input" },
    outputs: { value: "output" },
    status: "OK",
    latencyMs: 1,
    usage: {},
    costAvailable: false,
    links: [],
    attributes: {},
  };
}

function fixtureModel(spanId = "model", parentSpanId = "root"): SpanManifest {
  return {
    ...fixtureSpan("model call", "CHAT_MODEL", spanId, parentSpanId),
    model: "test-model",
    provider: "databricks",
    usage: { ...fixtureUsage },
    attributes: {
      streaming: true,
      ttft_ms: 2,
      stream_duration_ms: 8,
    },
  };
}

function fixtureManifest(children: SpanManifest[]): TraceManifest {
  return {
    template: "fixture-template",
    traceId: "0123456789abcdef0123456789abcdef",
    spans: [
      {
        ...fixtureSpan("request", "AGENT", "root", null),
        usage: { ...fixtureUsage },
        attributes: {
          app_id: "fixture-template",
          user_id: "user-1",
          session_id: "session-1",
        },
      },
      ...children,
    ],
  };
}

function validWorkloads(): TraceManifest[] {
  const tool = fixtureSpan("clock", "TOOL", "tool", "root");
  tool.inputs = { zone: "UTC" };
  tool.outputs = { time: "12:00" };
  const retriever = fixtureSpan(
    "vector search",
    "RETRIEVER",
    "retriever",
    "root",
  );
  const remote = fixtureSpan("remote agent", "TOOL", "remote", "root");
  remote.links = [
    {
      traceId: "fedcba9876543210fedcba9876543210",
      spanId: "0123456789abcdef",
    },
  ];
  remote.attributes = {
    remote_trace_id: "fedcba9876543210fedcba9876543210",
    remote_span_id: "0123456789abcdef",
    remote_lifecycle_complete: true,
  };
  return [
    fixtureManifest([fixtureModel()]),
    fixtureManifest([fixtureModel("plan"), tool]),
    fixtureManifest([retriever, fixtureModel("answer", "retriever")]),
    fixtureManifest([fixtureModel(), remote]),
  ];
}

test.each([
  ["simple", 0],
  ["tool-using", 1],
  ["retrieval-generation", 2],
  ["remote-agent", 3],
] as const)("accepts complete %s workload", (_name, index) => {
  expect(() => assertContract(validWorkloads()[index])).not.toThrow();
});

test("accepts truthful unavailable cost without inventing zero", () => {
  const manifest = fixtureManifest([fixtureModel()]);
  expect(manifest.spans[0].costUsd).toBeUndefined();
  expect(manifest.spans[1].costUsd).toBeUndefined();
  expect(() => assertContract(manifest)).not.toThrow();
});

test("accepts and exactly aggregates available model usage and cost", () => {
  const first = fixtureModel("model-1");
  first.usage = { input_tokens: 4, output_tokens: 1, total_tokens: 5 };
  first.costAvailable = true;
  first.costUsd = 0.01;
  const second = fixtureModel("model-2");
  second.usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
  second.costAvailable = true;
  second.costUsd = 0.02;
  const manifest = fixtureManifest([first, second]);
  manifest.spans[0].costAvailable = true;
  manifest.spans[0].costUsd = 0.03;
  expect(() => assertContract(manifest)).not.toThrow();
});

test.each([
  {
    name: "root-only trace",
    mutate(manifest: TraceManifest) {
      manifest.spans = manifest.spans.slice(0, 1);
    },
    expected: /semantic child/,
  },
  {
    name: "missing model output",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].outputs = undefined;
    },
    expected: /outputs/,
  },
  {
    name: "missing model usage",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].usage = {};
    },
    expected: /usage\.input_tokens/,
  },
  {
    name: "false zero cost",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].costUsd = 0;
    },
    expected: /cost_usd/,
  },
  {
    name: "orphan remote trace",
    mutate(manifest: TraceManifest) {
      manifest.spans[2].attributes = {
        remote_trace_id: "fedcba9876543210fedcba9876543210",
        remote_span_id: "0123456789abcdef",
        remote_lifecycle_complete: true,
      };
    },
    expected: /links/,
  },
  {
    name: "incomplete tool",
    mutate(manifest: TraceManifest) {
      manifest.spans[2].outputs = undefined;
    },
    expected: /outputs/,
  },
  {
    name: "missing identity",
    mutate(manifest: TraceManifest) {
      delete manifest.spans[0].attributes.user_id;
    },
    expected: /user_id/,
  },
  {
    name: "duplicate roots",
    mutate(manifest: TraceManifest) {
      manifest.spans.push(
        fixtureSpan("second request", "AGENT", "root-2", null),
      );
    },
    expected: /AGENT root/,
  },
  {
    name: "unfinalized span",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].status = "UNSET";
    },
    expected: /status/,
  },
  {
    name: "failure without partial output",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].status = "ERROR";
      manifest.spans[1].outputs = { error: "provider unavailable" };
    },
    expected: /partial_output/,
  },
  {
    name: "wrong input aggregation",
    mutate(manifest: TraceManifest) {
      manifest.spans[0].usage.input_tokens = 6;
    },
    expected: /usage\.input_tokens/,
  },
  {
    name: "credential leak",
    mutate(manifest: TraceManifest) {
      manifest.spans[2].inputs = { Authorization: "Bearer provider-secret" };
    },
    expected: /credentials/,
  },
  {
    name: "unsupported semantic type",
    mutate(manifest: TraceManifest) {
      manifest.spans[2].spanType = "HTTP";
    },
    expected: /span_type/,
  },
  {
    name: "missing provider",
    mutate(manifest: TraceManifest) {
      manifest.spans[1].provider = undefined;
    },
    expected: /provider/,
  },
  {
    name: "negative latency",
    mutate(manifest: TraceManifest) {
      manifest.spans[2].latencyMs = -1;
    },
    expected: /latency_ms/,
  },
] as const)(
  "rejects $name with template and span context",
  ({ mutate, expected }) => {
    const manifest = fixtureManifest([
      fixtureModel(),
      fixtureSpan("clock", "TOOL", "tool", "root"),
    ]);
    mutate(manifest);
    expect(() => assertContract(manifest)).toThrow(expected);
    try {
      assertContract(manifest);
    } catch (error) {
      expect(String(error)).toContain("fixture-template");
    }
  },
);

test.each(["ttft_ms", "stream_duration_ms"] as const)(
  "rejects streaming model missing %s",
  (field) => {
    const manifest = fixtureManifest([fixtureModel()]);
    delete manifest.spans[1].attributes[field];
    expect(() => assertContract(manifest)).toThrow(field);
  },
);

interface StatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  result?: { data_array?: unknown[][] };
}

function deriveUcBinding(
  catalog: string,
  schema: string,
  prefix: string,
): {
  location: Record<string, unknown>;
  spansTable: string;
  mlflowTracePrefix: string;
} {
  const spansTable = `${catalog}.${schema}.${prefix}_otel_spans`;
  return {
    location: {
      type: "UC_TABLE_PREFIX",
      uc_table_prefix: {
        catalog_name: catalog,
        schema_name: schema,
        table_prefix: prefix,
        otel_spans_table_name: spansTable,
      },
    },
    spansTable,
    mlflowTracePrefix: `trace:/${catalog}.${schema}.${prefix}/`,
  };
}

function otelTraceIdFromReturnedTrace(
  traceId: string,
  mlflowTracePrefix: string,
): string {
  if (!traceId.startsWith(mlflowTracePrefix)) {
    throw new Error(
      `returned trace ${traceId} is not bound to exact UC location ${mlflowTracePrefix}`,
    );
  }
  const otelTraceId = traceId.slice(mlflowTracePrefix.length);
  if (!/^[0-9a-f]{32}$/i.test(otelTraceId)) {
    throw new Error(
      `returned trace ${traceId} has no exact OTel trace identity`,
    );
  }
  return otelTraceId.toLowerCase();
}

async function pollStatement(
  initial: StatementResponse,
  getStatement: (statementId: string) => StatementResponse,
  sleep: () => Promise<void>,
  maxPolls = 120,
): Promise<StatementResponse> {
  let response = initial;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const state = response.status?.state;
    if (state === "SUCCEEDED") return response;
    if (state === "FAILED" || state === "CANCELED" || state === "CLOSED") {
      throw new Error(
        `UC trace row query ${state}: ${response.status?.error?.message ?? "unknown error"}`,
      );
    }
    if (!response.statement_id) {
      throw new Error(`UC trace row query is ${state} without a statement ID`);
    }
    await sleep();
    response = getStatement(response.statement_id);
  }
  throw new Error(`UC trace row query did not finish after ${maxPolls} polls`);
}

test("derives the exact immutable UC location, table, and MLflow trace prefix", () => {
  expect(deriveUcBinding("main", "agent_traces", "appkit")).toEqual({
    location: {
      type: "UC_TABLE_PREFIX",
      uc_table_prefix: {
        catalog_name: "main",
        schema_name: "agent_traces",
        table_prefix: "appkit",
        otel_spans_table_name: "main.agent_traces.appkit_otel_spans",
      },
    },
    spansTable: "main.agent_traces.appkit_otel_spans",
    mlflowTracePrefix: "trace:/main.agent_traces.appkit/",
  });
});

test("extracts the OTel trace ID only from the exact returned UC trace identity", () => {
  expect(
    otelTraceIdFromReturnedTrace(
      "trace:/main.agent_traces.appkit/0123456789abcdef0123456789abcdef",
      "trace:/main.agent_traces.appkit/",
    ),
  ).toBe("0123456789abcdef0123456789abcdef");
  expect(() =>
    otelTraceIdFromReturnedTrace(
      "trace:/other.schema.prefix/0123456789abcdef0123456789abcdef",
      "trace:/main.agent_traces.appkit/",
    ),
  ).toThrow(/exact UC location/);
});

test("polls asynchronous Statement Execution to success", async () => {
  const getStatement = vi.fn(() => ({
    statement_id: "statement-1",
    status: { state: "SUCCEEDED" },
    result: { data_array: [["trace"]] },
  }));
  const result = await pollStatement(
    { statement_id: "statement-1", status: { state: "PENDING" } },
    getStatement,
    async () => undefined,
  );
  expect(getStatement).toHaveBeenCalledWith("statement-1");
  expect(result.result?.data_array).toEqual([["trace"]]);
});

test.each(["FAILED", "CANCELED", "CLOSED"])(
  "reports terminal Statement Execution state %s",
  async (state) => {
    await expect(
      pollStatement(
        {
          statement_id: "statement-1",
          status: { state, error: { message: "warehouse rejected query" } },
        },
        () => ({ status: { state: "SUCCEEDED" } }),
        async () => undefined,
      ),
    ).rejects.toThrow(new RegExp(`${state}.*warehouse rejected query`, "i"));
  },
);

test("rejects nonterminal SQL without an identity and bounds polling", async () => {
  await expect(
    pollStatement(
      { status: { state: "PENDING" } },
      () => ({ status: { state: "SUCCEEDED" } }),
      async () => undefined,
    ),
  ).rejects.toThrow(/without a statement ID/);
  await expect(
    pollStatement(
      { statement_id: "statement-1", status: { state: "PENDING" } },
      () => ({ statement_id: "statement-1", status: { state: "RUNNING" } }),
      async () => undefined,
      2,
    ),
  ).rejects.toThrow(/after 2 polls/);
});

const deployedPrerequisites = [
  "APPKIT_TRACE_CONFORMANCE_URL",
  "APPKIT_TRACE_CONFORMANCE_APP_NAME",
  "APPKIT_TRACE_CONFORMANCE_PROFILE",
  "APPKIT_TRACE_CONFORMANCE_EXPERIMENT_ID",
  "APPKIT_TRACE_CONFORMANCE_WAREHOUSE_ID",
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
    const appName = process.env.APPKIT_TRACE_CONFORMANCE_APP_NAME ?? "";
    expect(["appkit-agents", "appkit-all-in-one"]).toContain(appName);
    const binding = deriveUcBinding(
      process.env.APPKIT_TRACE_CONFORMANCE_UC_CATALOG ?? "",
      process.env.APPKIT_TRACE_CONFORMANCE_UC_SCHEMA ?? "",
      process.env.APPKIT_TRACE_CONFORMANCE_UC_TABLE_PREFIX ?? "",
    );
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
    const otelTraceId = otelTraceIdFromReturnedTrace(
      traceId ?? "",
      binding.mlflowTracePrefix,
    );
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
    expect(location).toEqual(binding.location);

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
    const traceRecord = (storedTrace?.trace ?? storedTrace) as {
      info?: { trace_id?: string; traceId?: string };
      data?: { spans?: Array<Record<string, unknown>> };
    };
    expect(traceRecord.info?.trace_id ?? traceRecord.info?.traceId).toBe(
      traceId,
    );
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
                value: binding.spansTable,
              },
              { name: "trace_id", type: "STRING", value: otelTraceId },
            ],
          }),
        ],
        { encoding: "utf8" },
      ),
    );
    const completedSql = await pollStatement(
      sql,
      (statementId) =>
        JSON.parse(
          execFileSync(
            "databricks",
            [
              "api",
              "get",
              `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`,
              "-p",
              profile,
            ],
            { encoding: "utf8" },
          ),
        ),
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    );
    expect(completedSql.result?.data_array?.length).toBeGreaterThan(0);
    const storedSpans = traceRecord.data?.spans ?? [];
    const rows = (completedSql.result?.data_array ?? []).map((row) => ({
      traceId: row[0],
      spanId: row[1],
      parentSpanId: row[2],
      name: row[3],
      attributes: objectValue(row[4]),
    }));
    expect(new Set(rows.map((row) => row.traceId))).toEqual(
      new Set([otelTraceId]),
    );
    const persistedManifest: TraceManifest = {
      template: appName,
      traceId: otelTraceId,
      spans: rows.map((row) => {
        const source = storedSpans.find(
          (span) => (span.span_id ?? span.spanId) === row.spanId,
        );
        expect(
          source,
          `UC span ${String(row.spanId)} missing from MLflow`,
        ).toBeDefined();
        const attributes = row.attributes;
        attributes.app_id ??=
          attributes["app.id"] ?? attributes["appkit.app.name"];
        attributes.user_id ??=
          attributes["user.id"] ?? attributes["mlflow.trace.user"];
        attributes.session_id ??=
          attributes["session.id"] ?? attributes["mlflow.trace.session"];
        attributes.ttft_ms ??=
          attributes["appkit.ttft_ms"] ??
          attributes["appkit.first_token.duration_ms"];
        attributes.stream_duration_ms ??=
          attributes["appkit.stream_duration_ms"] ??
          attributes["appkit.stream.duration_ms"];
        if (
          attributes.ttft_ms !== undefined ||
          attributes.stream_duration_ms !== undefined
        ) {
          attributes.streaming = true;
        }
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
          status:
            (source?.status as { code?: string | number } | undefined)?.code ??
            (source?.status as { status_code?: string | number } | undefined)
              ?.status_code ??
            String(attributes["mlflow.spanStatus"] ?? "UNSET"),
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
    const persistedRoot = persistedManifest.spans.find(
      (span) => span.parentSpanId === null,
    );
    expect(persistedRoot?.attributes.app_id).toBe(appName);
    assertContract(persistedManifest);
  },
  180_000,
);
