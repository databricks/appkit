import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
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
import getPort from "get-port";
import type { AgentAdapter, AgentInput, AgentRunContext } from "shared";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { ServiceContext } from "../../../context/service-context";
import { createAgent } from "../../../core/agent/create-agent";
import { runAgent } from "../../../core/agent/run-agent";
import { tool } from "../../../core/agent/tools/tool";
import type { AgentDefinition } from "../../../core/agent/types";

const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const generatedApps = mkdtempSync(
  join(repositoryRoot, ".trace-conformance-generated-"),
);

interface GeneratedCandidate {
  name: string;
  directory: string;
}

function discoverGeneratedAgentTemplates(): GeneratedCandidate[] {
  const behaviorSignals = [
    /\bAgentServer\b/,
    /\b(?:createAgent|agents)\s*\(/,
    /agents:\s*\{/,
    /\/(?:invocations|responses|api\/agents)\b/,
    /(?:for\s+await|while\s*\()[\s\S]*?\bmodel\b[\s\S]*?\b(?:tool|executeTool)\b/i,
    /\b(?:retriev|vectorSearch)\w*[\s\S]*?\b(?:generat|model)\w*/i,
  ];
  return readdirSync(generatedApps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      directory: join(generatedApps, entry.name),
    }))
    .filter(({ directory }) => {
      const sources = readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
      })
        .filter(
          (relative) =>
            !relative.includes("node_modules/") &&
            /\.(?:ts|tsx|js|jsx|py)$/.test(relative),
        )
        .map((relative) => readFileSync(join(directory, relative), "utf8"));
      return behaviorSignals.some((signal) =>
        sources.some((source) => signal.test(source)),
      );
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

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
  const semanticSpanIds = new Set(
    spans.map((span) => span.spanContext().spanId),
  );
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
      const spanType = String(attributes["mlflow.spanType"] ?? "");
      const recordedParentSpanId = span.parentSpanContext?.spanId;
      return {
        name: span.name,
        spanType,
        spanId: span.spanContext().spanId,
        parentSpanId:
          spanType === "AGENT" &&
          recordedParentSpanId !== undefined &&
          !semanticSpanIds.has(recordedParentSpanId)
            ? null
            : (recordedParentSpanId ?? null),
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

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function captureGeneratedHttpTurn(
  candidate: GeneratedCandidate,
): Promise<TraceManifest> {
  const { name: template, directory } = candidate;
  const helperPath = join(directory, "server/agents/helper.ts");
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
  const port = await getPort();
  const environment = {
    NODE_ENV: "production",
    DISABLE_APPKIT_INTERNAL_TELEMETRY: "true",
    DATABRICKS_APP_PORT: String(port),
    FLASK_RUN_HOST: "127.0.0.1",
    DATABRICKS_APP_NAME: template,
    DATABRICKS_HOST: "https://test.databricks.com",
    DATABRICKS_CLIENT_ID: "test-client-id",
    DATABRICKS_AGENT_SERVING_ENDPOINT_NAME: "generated-test-model",
    DATABRICKS_WAREHOUSE_ID: "test-warehouse",
    DATABRICKS_VOLUME_FILES: "/Volumes/main/default/files",
    DATABRICKS_GENIE_SPACE_ID: "test-genie-space",
    DATABRICKS_SERVING_ENDPOINT_NAME: "test-serving-endpoint",
    LAKEBASE_ENDPOINT: "test-lakebase-endpoint",
    PGUSER: "test-client-id",
    PGHOST: "localhost",
    PGDATABASE: "appkit",
    PGPORT: "5432",
    PGSSLMODE: "require",
    MLFLOW_EXPERIMENT_ID: "test-experiment",
    MLFLOW_TRACING_SQL_WAREHOUSE_ID: "test-warehouse",
    MLFLOW_UC_CATALOG: "main",
    MLFLOW_UC_SCHEMA: "agent_traces",
    MLFLOW_UC_TABLE_PREFIX: "appkit",
    MLFLOW_OTEL_SPANS_TABLE: "main.agent_traces.appkit_otel_spans",
  };
  const previousEnvironment = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  const serviceContext = {
    client: {},
    serviceUserId: "test-client-id",
    warehouseId: Promise.resolve("test-warehouse"),
    workspaceId: Promise.resolve("test-workspace"),
  };
  const initializeServiceContext = vi
    .spyOn(ServiceContext, "initialize")
    .mockResolvedValue(serviceContext as never);
  const getServiceContext = vi
    .spyOn(ServiceContext, "get")
    .mockReturnValue(serviceContext as never);
  let server: Server | undefined;
  let appkit:
    | { server: { getServer(): Server }; shutdown(): Promise<void> }
    | undefined;
  try {
    const requireFromGeneratedPackage = createRequire(
      join(directory, "package.json"),
    );
    expect(
      requireFromGeneratedPackage.resolve("@databricks/appkit/package.json"),
      `${template} generated package resolution`,
    ).toBe(join(repositoryRoot, "packages/appkit/package.json"));

    const serverPath = join(directory, "server/server.ts");
    const generatedServer = (await import(pathToFileURL(serverPath).href)) as {
      app?: Promise<{
        server: { getServer(): Server };
        shutdown(): Promise<void>;
      }>;
    };
    expect(
      generatedServer.app,
      `${template} must export its generated createApp execution`,
    ).toBeDefined();
    appkit = await generatedServer.app;
    server = appkit?.server.getServer();
    if (!server) {
      throw new Error(
        `${template} generated createApp did not expose its server`,
      );
    }
    if (!server.listening) {
      await new Promise<void>((resolveListening, rejectListening) => {
        server?.once("listening", resolveListening);
        server?.once("error", rejectListening);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error(`${template} generated HTTP server did not bind a port`);
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/invocations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-user": "user-1",
          "x-mlflow-session-id": "session-1",
          "x-request-id": "request-1",
        },
        body: JSON.stringify({
          input: "Count the words in hello traced world. Use count_words.",
        }),
      },
    );
    const responseBody = await response.text();
    expect(
      response.ok,
      `${template} HTTP ${response.status}: ${responseBody}`,
    ).toBe(true);
    expect(
      response.headers.get("x-mlflow-trace-id"),
      `${template} generated handler trace identity`,
    ).toBeTruthy();
    await provider.forceFlush();
    const semanticSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["mlflow.spanType"] !== undefined);
    return normalize(template, semanticSpans);
  } finally {
    try {
      if (appkit) await appkit.shutdown();
      else await closeServer(server);
    } finally {
      initializeServiceContext.mockRestore();
      getServiceContext.mockRestore();
      for (const [name, previous] of previousEnvironment) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      getTracer.mockRestore();
      await provider.shutdown();
    }
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

test("every behavior-discovered generated surface executes its HTTP trace proof", async () => {
  const candidates = discoverGeneratedAgentTemplates();
  expect(candidates.length).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const requestedCandidate = process.env.APPKIT_TRACE_CONFORMANCE_CANDIDATE;
      if (requestedCandidate === candidate.name) {
        const sourceDirectory =
          process.env.APPKIT_TRACE_CONFORMANCE_SOURCE_DIRECTORY;
        if (!sourceDirectory) {
          throw new Error(
            `${candidate.name} owner proof is missing its generated source directory`,
          );
        }
        for (const relative of [
          "server/server.ts",
          "server/agents/helper.ts",
        ]) {
          expect(
            readFileSync(join(sourceDirectory, relative), "utf8"),
            `${candidate.name} source provenance ${relative}`,
          ).toBe(readFileSync(join(candidate.directory, relative), "utf8"));
        }
      }
      const baselineSigterm = process.listenerCount("SIGTERM");
      const baselineSigint = process.listenerCount("SIGINT");
      const localManifest = await captureTurn(candidate.name);
      const reloaded = JSON.parse(
        JSON.stringify(localManifest),
      ) as TraceManifest;
      assertContract(reloaded);

      const manifest = await captureGeneratedHttpTurn(candidate);
      expect(process.listenerCount("SIGTERM"), candidate.name).toBe(
        baselineSigterm,
      );
      expect(process.listenerCount("SIGINT"), candidate.name).toBe(
        baselineSigint,
      );
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
      if (
        process.env.APPKIT_TRACE_CONFORMANCE_CANDIDATE === candidate.name &&
        process.env.TRACE_CONFORMANCE_MANIFEST
      ) {
        writePythonManifest(process.env.TRACE_CONFORMANCE_MANIFEST, manifest);
      }
    } catch (error) {
      failures.push(
        `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  expect(
    failures,
    `discovered candidates without executable generated HTTP proof:\n${failures.join("\n")}`,
  ).toEqual([]);
}, 120_000);

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

function writePythonManifest(path: string, manifest: TraceManifest): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        template: manifest.template,
        trace_id: manifest.traceId,
        spans: manifest.spans.map((span) => ({
          name: span.name,
          span_type: span.spanType,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId,
          inputs: span.inputs,
          outputs: span.outputs,
          status:
            span.status === 1
              ? "OK"
              : span.status === 2
                ? "ERROR"
                : span.status,
          latency_ms: span.latencyMs,
          model: span.model ?? null,
          provider: span.provider ?? null,
          usage: span.usage,
          cost_usd: span.costUsd ?? null,
          cost_available: span.costAvailable,
          links: span.links,
          attributes: span.attributes,
        })),
      },
      null,
      2,
    )}\n`,
  );
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

const persistedSpanStatement =
  "SELECT trace_id, span_id, parent_span_id, name, attributes, " +
  "status_code, start_time_unix_nano, end_time_unix_nano\n" +
  "FROM IDENTIFIER(:otel_spans_table)\n" +
  "WHERE trace_id = :trace_id\n" +
  "ORDER BY start_time_unix_nano";

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

interface UcSpanRow {
  traceId: unknown;
  spanId: unknown;
  parentSpanId: unknown;
  name: unknown;
  attributes: Record<string, unknown>;
  statusCode?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
}

interface DeployedTraceProof {
  appName: string;
  configuredExperimentId: string;
  requestBody: unknown;
  responseBody: unknown;
  expectedTool: {
    name: string;
    inputs: unknown;
    outputs: unknown;
  };
  returnedTraceId: string;
  binding: ReturnType<typeof deriveUcBinding>;
  experiment: {
    experiment?: {
      experiment_id?: string;
      trace_location?: Record<string, unknown>;
    };
  };
  traceRecord: {
    info?: {
      trace_id?: string;
      traceId?: string;
      experiment_id?: string;
      experimentId?: string;
    };
    data?: { spans?: Array<Record<string, unknown>> };
  };
  rows: UcSpanRow[];
}

function deployedProofFixture(): DeployedTraceProof {
  const appName = "appkit-agents";
  const configuredExperimentId = "experiment-123";
  const binding = deriveUcBinding("main", "agent_traces", "appkit");
  const manifest = validWorkloads()[1];
  manifest.template = appName;
  manifest.spans[0].attributes.app_id = appName;
  const returnedTraceId = `${binding.mlflowTracePrefix}${manifest.traceId}`;
  const requestBody = {
    input: "Count the words in hello traced world. Use count_words.",
  };
  const responseBody = {
    object: "response",
    status: "completed",
    trace_id: returnedTraceId,
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: "3" }],
      },
    ],
  };
  const expectedTool = {
    name: "count_words tool",
    inputs: { text: "hello traced world" },
    outputs: { text: "hello traced world", word_count: 3 },
  };
  manifest.spans[0].inputs = requestBody;
  manifest.spans[0].outputs = responseBody;
  const toolSpan = manifest.spans.find((span) => span.spanType === "TOOL");
  if (!toolSpan) throw new Error("deployed fixture requires a TOOL span");
  toolSpan.name = expectedTool.name;
  toolSpan.inputs = expectedTool.inputs;
  toolSpan.outputs = expectedTool.outputs;
  const rows = manifest.spans.map((span, index) => ({
    traceId: manifest.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    attributes: {
      ...span.attributes,
      "mlflow.spanType": span.spanType,
      "mlflow.spanInputs": span.inputs,
      "mlflow.spanOutputs": span.outputs,
      [span.spanType === "AGENT"
        ? "mlflow.trace.tokenUsage"
        : "mlflow.chat.tokenUsage"]: span.usage,
      "mlflow.chat.model": span.model,
      "mlflow.chat.provider": span.provider,
      "mlflow.llm.cost": span.costUsd,
      "appkit.cost.available": span.costAvailable,
      "appkit.app.name": span.attributes.app_id,
      "mlflow.trace.user": span.attributes.user_id,
      "mlflow.trace.session": span.attributes.session_id,
    },
    statusCode: "OK",
    startTimeUnixNano: String(1_000_000 + index * 2_000_000),
    endTimeUnixNano: String(2_000_000 + index * 2_000_000),
  }));
  return {
    appName,
    configuredExperimentId,
    requestBody,
    responseBody,
    expectedTool,
    returnedTraceId,
    binding,
    experiment: {
      experiment: {
        experiment_id: configuredExperimentId,
        trace_location: binding.location,
      },
    },
    traceRecord: {
      info: {
        trace_id: returnedTraceId,
        experiment_id: configuredExperimentId,
      },
      data: {
        spans: rows.map((row) => ({
          span_id: row.spanId,
          parent_span_id: row.parentSpanId,
          name: row.name,
          attributes: structuredClone(row.attributes),
          status: { code: "OK" },
          latency_ms: 1,
        })),
      },
    },
    rows,
  };
}

function normalizeUcStatus(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return "UNSET";
  return value
    .trim()
    .toUpperCase()
    .replace(/^STATUS_CODE_/, "");
}

function unixNanos(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function ucLatencyMs(row: UcSpanRow): number {
  const start = unixNanos(row.startTimeUnixNano);
  const end = unixNanos(row.endTimeUnixNano);
  if (start === undefined || end === undefined || end < start) return -1;
  return Number(end - start) / 1_000_000;
}

function assertAppIdentity(
  attributes: Record<string, unknown>,
  expected: string,
  source: string,
): void {
  const values = [
    attributes.app_id,
    attributes["app.id"],
    attributes["appkit.app.name"],
  ].filter((value) => value !== undefined);
  if (values.length === 0 || values.some((value) => value !== expected)) {
    throw new Error(`${source} app identity does not match configured app`);
  }
}

function canonicalTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTraceValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalTraceValue(nested)]),
    );
  }
  return value;
}

function assertExactTraceValue(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (
    JSON.stringify(canonicalTraceValue(actual)) !==
    JSON.stringify(canonicalTraceValue(expected))
  ) {
    throw new Error(`${label} does not match the deployed turn`);
  }
}

function normalizeUcRows(
  template: string,
  traceId: string,
  rows: UcSpanRow[],
): TraceManifest {
  return {
    template,
    traceId,
    spans: rows.map((row) => {
      const attributes = { ...row.attributes };
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
      const rawParentSpanId = row.parentSpanId
        ? String(row.parentSpanId)
        : null;
      return {
        name: String(row.name),
        spanType,
        spanId: String(row.spanId),
        parentSpanId: rawParentSpanId,
        inputs: decoded(attributes["mlflow.spanInputs"]),
        outputs: decoded(attributes["mlflow.spanOutputs"]),
        status: normalizeUcStatus(row.statusCode),
        latencyMs: ucLatencyMs(row),
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
}

function normalizeMlflowSpans(
  template: string,
  traceId: string,
  spans: Array<Record<string, unknown>>,
): TraceManifest {
  return {
    template,
    traceId,
    spans: spans.map((span) => {
      const attributes = { ...objectValue(span.attributes) };
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
      const rawParentSpanId = span.parent_span_id ?? span.parentSpanId;
      const parentSpanId =
        rawParentSpanId === undefined || rawParentSpanId === null
          ? null
          : String(rawParentSpanId);
      const statusRecord = objectValue(span.status);
      return {
        name: String(span.name),
        spanType,
        spanId: String(span.span_id ?? span.spanId),
        parentSpanId,
        inputs: decoded(attributes["mlflow.spanInputs"]),
        outputs: decoded(attributes["mlflow.spanOutputs"]),
        status: normalizeUcStatus(
          statusRecord.code ?? statusRecord.status_code ?? span.status,
        ),
        latencyMs: Number(span.latency_ms ?? span.latencyMs ?? -1),
        model: attributes["mlflow.chat.model"] as string | undefined,
        provider: attributes["mlflow.chat.provider"] as string | undefined,
        usage,
        costUsd: attributes["mlflow.llm.cost"] as number | undefined,
        costAvailable: attributes["appkit.cost.available"] === true,
        links: Array.isArray(span.links) ? span.links : [],
        attributes,
      };
    }),
  };
}

function contractSemantics(span: SpanManifest): Record<string, unknown> {
  return {
    name: span.name,
    spanType: span.spanType,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    inputs: span.inputs,
    outputs: span.outputs,
    status: span.status,
    latencyMs: span.latencyMs,
    model: span.model,
    provider: span.provider,
    usage: span.usage,
    costUsd: span.costUsd,
    costAvailable: span.costAvailable,
    links: span.links,
    attributes: span.attributes,
    identity: {
      app_id: span.attributes.app_id,
      user_id: span.attributes.user_id,
      session_id: span.attributes.session_id,
    },
    streaming: {
      enabled: span.attributes.streaming,
      ttft_ms: span.attributes.ttft_ms,
      stream_duration_ms: span.attributes.stream_duration_ms,
    },
  };
}

function semanticProjection(manifest: TraceManifest): TraceManifest {
  const spans = manifest.spans.filter((span) => span.spanType !== "");
  const semanticSpanIds = new Set(spans.map((span) => span.spanId));
  return {
    ...manifest,
    spans: spans.map((span) => ({
      ...span,
      parentSpanId:
        span.spanType === "AGENT" &&
        span.parentSpanId !== null &&
        !semanticSpanIds.has(span.parentSpanId)
          ? null
          : span.parentSpanId,
    })),
  };
}

function assertCrossSourceParity(
  mlflow: TraceManifest,
  uc: TraceManifest,
): void {
  if (mlflow.traceId !== uc.traceId) {
    throw new Error("MLflow and UC trace identities do not match exactly");
  }
  const mlflowById = new Map(
    mlflow.spans.map((span) => [span.spanId, span] as const),
  );
  const ucById = new Map(uc.spans.map((span) => [span.spanId, span] as const));
  if (
    mlflowById.size !== mlflow.spans.length ||
    ucById.size !== uc.spans.length ||
    mlflowById.size !== ucById.size ||
    [...mlflowById.keys()].some((spanId) => !ucById.has(spanId)) ||
    [...ucById.keys()].some((spanId) => !mlflowById.has(spanId))
  ) {
    throw new Error("MLflow and UC span identity sets do not match exactly");
  }
  for (const [spanId, mlflowSpan] of mlflowById) {
    const ucSpan = ucById.get(spanId);
    if (!ucSpan || mlflowSpan.parentSpanId !== ucSpan.parentSpanId) {
      throw new Error(
        `MLflow and UC parent identity differs for span ${spanId}`,
      );
    }
    const mlflowSemantics = contractSemantics(mlflowSpan);
    const ucSemantics = contractSemantics(ucSpan);
    for (const field of Object.keys(mlflowSemantics)) {
      if (
        JSON.stringify(canonicalTraceValue(mlflowSemantics[field])) !==
        JSON.stringify(canonicalTraceValue(ucSemantics[field]))
      ) {
        throw new Error(
          `MLflow and UC semantics ${field} differs for span ${spanId}`,
        );
      }
    }
  }
}

function validateDeployedProof(proof: DeployedTraceProof): TraceManifest {
  const experiment = proof.experiment.experiment;
  if (experiment?.experiment_id !== proof.configuredExperimentId) {
    throw new Error(
      `experiment API returned ${String(experiment?.experiment_id)} for configured experiment ${proof.configuredExperimentId}`,
    );
  }
  if (
    JSON.stringify(experiment.trace_location) !==
    JSON.stringify(proof.binding.location)
  ) {
    throw new Error(
      "experiment trace location does not match configured UC binding",
    );
  }
  const traceInfo = proof.traceRecord.info;
  const storedTraceId = traceInfo?.trace_id ?? traceInfo?.traceId;
  if (storedTraceId !== proof.returnedTraceId) {
    throw new Error(
      `MLflow trace ${String(storedTraceId)} does not match returned trace ${proof.returnedTraceId}`,
    );
  }
  const storedExperimentId =
    traceInfo?.experiment_id ?? traceInfo?.experimentId;
  if (storedExperimentId !== proof.configuredExperimentId) {
    throw new Error(
      `MLflow trace experiment ${String(storedExperimentId)} does not match configured experiment ${proof.configuredExperimentId}`,
    );
  }
  const otelTraceId = otelTraceIdFromReturnedTrace(
    proof.returnedTraceId,
    proof.binding.mlflowTracePrefix,
  );
  if (proof.rows.length === 0) {
    throw new Error(
      `UC table ${proof.binding.spansTable} returned no trace rows`,
    );
  }
  for (const row of proof.rows) {
    if (String(row.traceId).toLowerCase() !== otelTraceId) {
      throw new Error(
        `UC row trace ${String(row.traceId)} does not match returned OTel trace ${otelTraceId}`,
      );
    }
  }

  const mlflowSpans = proof.traceRecord.data?.spans ?? [];
  const mlflowSpanIdentities = mlflowSpans.map((span) =>
    String(span.span_id ?? span.spanId),
  );
  const ucSpanIdentities = proof.rows.map((row) => String(row.spanId));
  const mlflowSpanIds = new Set(mlflowSpanIdentities);
  const ucSpanIds = new Set(ucSpanIdentities);
  // The shared contract does not permit an unpaired provider-created span,
  // so there is intentionally no identity exception here.
  if (
    mlflowSpanIds.size !== mlflowSpanIdentities.length ||
    ucSpanIds.size !== ucSpanIdentities.length ||
    mlflowSpanIds.size !== ucSpanIds.size ||
    [...mlflowSpanIds].some((spanId) => !ucSpanIds.has(spanId)) ||
    [...ucSpanIds].some((spanId) => !mlflowSpanIds.has(spanId))
  ) {
    throw new Error("MLflow and UC span identity sets do not match exactly");
  }
  const semanticRows = proof.rows.filter(
    (row) => row.attributes["mlflow.spanType"] !== undefined,
  );
  for (const row of semanticRows) {
    if (!mlflowSpanIds.has(String(row.spanId))) {
      throw new Error(
        `UC span ${String(row.spanId)} is not associated with the returned MLflow trace`,
      );
    }
  }

  const mlflowRoot = mlflowSpans.find(
    (span) => objectValue(span.attributes)["mlflow.spanType"] === "AGENT",
  );
  assertAppIdentity(
    objectValue(mlflowRoot?.attributes),
    proof.appName,
    "MLflow trace",
  );

  const ucRoot = semanticRows.find(
    (row) => row.attributes["mlflow.spanType"] === "AGENT",
  );
  if (!ucRoot) {
    throw new Error("UC trace app identity does not match configured app");
  }
  assertAppIdentity(ucRoot.attributes, proof.appName, "UC trace");

  const rawMlflowManifest = normalizeMlflowSpans(
    proof.appName,
    otelTraceId,
    mlflowSpans,
  );
  const rawUcManifest = normalizeUcRows(proof.appName, otelTraceId, proof.rows);
  assertCrossSourceParity(rawMlflowManifest, rawUcManifest);
  const mlflowManifest = semanticProjection(rawMlflowManifest);
  const ucManifest = semanticProjection(rawUcManifest);
  assertContract(mlflowManifest);
  assertContract(ucManifest);
  assertCrossSourceParity(mlflowManifest, ucManifest);
  const roots = ucManifest.spans.filter(
    (span) => span.parentSpanId === null && span.spanType === "AGENT",
  );
  if (roots.length !== 1) {
    throw new Error("deployed trace does not have one exact AGENT root");
  }
  const root = roots[0];
  assertExactTraceValue("AGENT request input", root.inputs, proof.requestBody);
  if (proof.responseBody === undefined || proof.responseBody === null) {
    throw new Error("deployed response output is missing");
  }
  const responseTraceId = objectValue(proof.responseBody).trace_id;
  if (responseTraceId !== proof.returnedTraceId) {
    throw new Error("deployed response trace ID does not match returned trace");
  }
  assertExactTraceValue(
    "AGENT response output",
    root.outputs,
    proof.responseBody,
  );
  if (
    !ucManifest.spans.some(
      (span) => span.spanType === "CHAT_MODEL" || span.spanType === "LLM",
    )
  ) {
    throw new Error("deployed trace is missing an LLM span");
  }
  const toolSpan = ucManifest.spans.find(
    (span) => span.spanType === "TOOL" && span.name === proof.expectedTool.name,
  );
  if (!toolSpan) {
    throw new Error(
      `deployed trace is missing TOOL ${proof.expectedTool.name}`,
    );
  }
  assertExactTraceValue(
    "TOOL inputs",
    toolSpan.inputs,
    proof.expectedTool.inputs,
  );
  assertExactTraceValue(
    "TOOL outputs",
    toolSpan.outputs,
    proof.expectedTool.outputs,
  );
  return ucManifest;
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

test("queries UC-native status and timing for the exact returned trace", () => {
  expect(persistedSpanStatement).toBe(
    "SELECT trace_id, span_id, parent_span_id, name, attributes, " +
      "status_code, start_time_unix_nano, end_time_unix_nano\n" +
      "FROM IDENTIFIER(:otel_spans_table)\n" +
      "WHERE trace_id = :trace_id\n" +
      "ORDER BY start_time_unix_nano",
  );
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

test.each([
  [
    "experiment API",
    (proof: DeployedTraceProof) => {
      if (proof.experiment.experiment) {
        proof.experiment.experiment.experiment_id = "wrong-experiment";
      }
    },
  ],
  [
    "MLflow trace",
    (proof: DeployedTraceProof) => {
      if (proof.traceRecord.info) {
        proof.traceRecord.info.experiment_id = "wrong-experiment";
      }
    },
  ],
] as const)(
  "rejects a wrong configured experiment association from %s despite the matching UC location",
  (_name, mutate) => {
    const proof = deployedProofFixture();
    mutate(proof);
    expect(() => validateDeployedProof(proof)).toThrow(/experiment/i);
  },
);

test.each([
  [
    "returned trace",
    (proof: DeployedTraceProof) => {
      if (proof.traceRecord.info) {
        proof.traceRecord.info.trace_id = `${proof.binding.mlflowTracePrefix}fedcba9876543210fedcba9876543210`;
      }
    },
  ],
  [
    "MLflow app",
    (proof: DeployedTraceProof) => {
      const root = proof.traceRecord.data?.spans?.find(
        (span) => !span.parent_span_id,
      );
      if (root) objectValue(root.attributes)["appkit.app.name"] = "other-app";
    },
  ],
  [
    "UC app",
    (proof: DeployedTraceProof) => {
      const root = proof.rows.find((row) => !row.parentSpanId);
      if (root) root.attributes["appkit.app.name"] = "other-app";
    },
  ],
] as const)("rejects a wrong %s association", (_name, mutate) => {
  const proof = deployedProofFixture();
  mutate(proof);
  expect(() => validateDeployedProof(proof)).toThrow(/trace|app/i);
});

test.each([
  ["missing UC status", (row: UcSpanRow) => delete row.statusCode],
  [
    "nonterminal UC status",
    (row: UcSpanRow) => {
      row.statusCode = "UNSET";
    },
  ],
  ["missing UC end time", (row: UcSpanRow) => delete row.endTimeUnixNano],
  [
    "negative UC duration",
    (row: UcSpanRow) => {
      row.endTimeUnixNano = "0";
    },
  ],
] as const)(
  "rejects %s without borrowing correct MLflow lifecycle values",
  (_name, mutate) => {
    const proof = deployedProofFixture();
    mutate(proof.rows[0]);
    expect(() => validateDeployedProof(proof)).toThrow(/status|latency/i);
  },
);

test.each([
  [
    "missing response output",
    (proof: DeployedTraceProof) => {
      proof.responseBody = undefined;
    },
  ],
  [
    "wrong response output",
    (proof: DeployedTraceProof) => {
      proof.responseBody = {
        object: "response",
        status: "completed",
        trace_id: proof.returnedTraceId,
        output: [{ content: [{ type: "output_text", text: "wrong" }] }],
      };
    },
  ],
] as const)(
  "rejects %s that is not bound to the AGENT root",
  (_name, mutate) => {
    const proof = deployedProofFixture();
    mutate(proof);
    expect(() => validateDeployedProof(proof)).toThrow(/response|output/i);
  },
);

test.each([
  [
    "absent TOOL span",
    (proof: DeployedTraceProof) => {
      const toolRow = proof.rows.find(
        (row) => row.attributes["mlflow.spanType"] === "TOOL",
      );
      proof.rows = proof.rows.filter((row) => row !== toolRow);
      if (toolRow && proof.traceRecord.data?.spans) {
        proof.traceRecord.data.spans = proof.traceRecord.data.spans.filter(
          (span) =>
            String(span.span_id ?? span.spanId) !== String(toolRow.spanId),
        );
      }
    },
  ],
  [
    "wrong TOOL span",
    (proof: DeployedTraceProof) => {
      const toolRow = proof.rows.find(
        (row) => row.attributes["mlflow.spanType"] === "TOOL",
      );
      if (toolRow) toolRow.name = "different tool";
    },
  ],
  [
    "wrong TOOL inputs",
    (proof: DeployedTraceProof) => {
      const toolRow = proof.rows.find(
        (row) => row.attributes["mlflow.spanType"] === "TOOL",
      );
      if (toolRow) toolRow.attributes["mlflow.spanInputs"] = { text: "wrong" };
    },
  ],
  [
    "wrong TOOL outputs",
    (proof: DeployedTraceProof) => {
      const toolRow = proof.rows.find(
        (row) => row.attributes["mlflow.spanType"] === "TOOL",
      );
      if (toolRow)
        toolRow.attributes["mlflow.spanOutputs"] = { word_count: 99 };
    },
  ],
] as const)(
  "rejects %s for the deterministic deployed turn",
  (_name, mutate) => {
    const proof = deployedProofFixture();
    mutate(proof);
    expect(() => validateDeployedProof(proof)).toThrow(/TOOL/i);
  },
);

test("rejects an extra MLflow span missing from UC", () => {
  const proof = deployedProofFixture();
  proof.traceRecord.data?.spans?.push({
    span_id: "mlflow-only",
    parent_span_id: null,
    name: "provider bookkeeping",
    attributes: {},
  });

  expect(() => validateDeployedProof(proof)).toThrow(/span identity/i);
});

test("rejects an extra UC span missing from MLflow", () => {
  const proof = deployedProofFixture();
  proof.rows.push({
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "uc-only",
    parentSpanId: null,
    name: "provider bookkeeping",
    attributes: {},
    statusCode: "OK",
    startTimeUnixNano: "1000000",
    endTimeUnixNano: "2000000",
  });

  expect(() => validateDeployedProof(proof)).toThrow(/span identity/i);
});

function addPairedNonSemanticSpan(
  proof: DeployedTraceProof,
  {
    spanId = "provider-wrapper",
    parentSpanId = null,
  }: { spanId?: string; parentSpanId?: string | null } = {},
): void {
  proof.rows.push({
    traceId: "0123456789abcdef0123456789abcdef",
    spanId,
    parentSpanId,
    name: "provider bookkeeping",
    attributes: {
      "http.request.body": { prompt: "hello" },
      "http.response.body": { answer: "world" },
      "http.route": "/invocations",
    },
    statusCode: "OK",
    startTimeUnixNano: "11000000",
    endTimeUnixNano: "12000000",
  });
  proof.traceRecord.data?.spans?.push({
    span_id: spanId,
    parent_span_id: parentSpanId,
    name: "provider bookkeeping",
    attributes: {
      "http.request.body": { prompt: "hello" },
      "http.response.body": { answer: "world" },
      "http.route": "/invocations",
    },
    status: { code: "OK" },
    latency_ms: 1,
  });
}

test.each([
  [
    "parent",
    (span: Record<string, unknown>) => {
      span.parent_span_id = "root";
    },
  ],
  [
    "name",
    (span: Record<string, unknown>) => {
      span.name = "different provider bookkeeping";
    },
  ],
  [
    "status",
    (span: Record<string, unknown>) => {
      span.status = { code: "ERROR" };
    },
  ],
  [
    "latency",
    (span: Record<string, unknown>) => {
      span.latency_ms = 2;
    },
  ],
  [
    "input",
    (span: Record<string, unknown>) => {
      objectValue(span.attributes)["http.request.body"] = { prompt: "wrong" };
    },
  ],
  [
    "output",
    (span: Record<string, unknown>) => {
      objectValue(span.attributes)["http.response.body"] = { answer: "wrong" };
    },
  ],
  [
    "attribute",
    (span: Record<string, unknown>) => {
      objectValue(span.attributes)["http.route"] = "/wrong";
    },
  ],
] as const)("rejects paired non-semantic span %s mismatch", (_name, mutate) => {
  const proof = deployedProofFixture();
  addPairedNonSemanticSpan(proof);
  const span = proof.traceRecord.data?.spans?.find(
    (candidate) => candidate.span_id === "provider-wrapper",
  );
  if (!span) throw new Error("fixture requires provider wrapper");
  mutate(span);

  expect(() => validateDeployedProof(proof)).toThrow(
    /parent|parity|semantics/i,
  );
});

test("rejects a semantic AGENT child whose filtered parent differs by source", () => {
  const proof = deployedProofFixture();
  addPairedNonSemanticSpan(proof);
  addPairedNonSemanticSpan(proof, { spanId: "other-provider-wrapper" });
  const mlflowRoot = proof.traceRecord.data?.spans?.find(
    (span) => objectValue(span.attributes)["mlflow.spanType"] === "AGENT",
  );
  const ucRoot = proof.rows.find(
    (row) => row.attributes["mlflow.spanType"] === "AGENT",
  );
  if (!mlflowRoot || !ucRoot) throw new Error("fixture requires AGENT roots");
  mlflowRoot.parent_span_id = "provider-wrapper";
  ucRoot.parentSpanId = "other-provider-wrapper";

  expect(() => validateDeployedProof(proof)).toThrow(/parent|parity/i);
});

test.each([
  [
    "missing MLflow AGENT request",
    (proof: DeployedTraceProof) => {
      const root = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "AGENT",
      );
      delete objectValue(root?.attributes)["mlflow.spanInputs"];
    },
  ],
  [
    "incorrect MLflow AGENT response",
    (proof: DeployedTraceProof) => {
      const root = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "AGENT",
      );
      objectValue(root?.attributes)["mlflow.spanOutputs"] = { output: "wrong" };
    },
  ],
  [
    "incorrect MLflow TOOL name",
    (proof: DeployedTraceProof) => {
      const tool = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "TOOL",
      );
      if (tool) tool.name = "wrong tool";
    },
  ],
  [
    "missing MLflow TOOL input",
    (proof: DeployedTraceProof) => {
      const tool = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "TOOL",
      );
      delete objectValue(tool?.attributes)["mlflow.spanInputs"];
    },
  ],
  [
    "incorrect MLflow TOOL output",
    (proof: DeployedTraceProof) => {
      const tool = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "TOOL",
      );
      objectValue(tool?.attributes)["mlflow.spanOutputs"] = { word_count: 99 };
    },
  ],
  [
    "missing MLflow model input",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      delete objectValue(model?.attributes)["mlflow.spanInputs"];
    },
  ],
  [
    "incorrect MLflow model output",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      objectValue(model?.attributes)["mlflow.spanOutputs"] = { text: "wrong" };
    },
  ],
  [
    "missing MLflow model usage",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      delete objectValue(model?.attributes)["mlflow.chat.tokenUsage"];
    },
  ],
  [
    "incorrect MLflow model cost",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      objectValue(model?.attributes)["mlflow.llm.cost"] = 99;
    },
  ],
  [
    "missing MLflow model timing",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      delete objectValue(model?.attributes).ttft_ms;
    },
  ],
  [
    "incorrect MLflow model status",
    (proof: DeployedTraceProof) => {
      const model = proof.traceRecord.data?.spans?.find((span) =>
        ["CHAT_MODEL", "LLM"].includes(
          String(objectValue(span.attributes)["mlflow.spanType"]),
        ),
      );
      if (model) model.status = { code: "UNSET" };
    },
  ],
  [
    "incorrect MLflow topology",
    (proof: DeployedTraceProof) => {
      const tool = proof.traceRecord.data?.spans?.find(
        (span) => objectValue(span.attributes)["mlflow.spanType"] === "TOOL",
      );
      if (tool) tool.parent_span_id = "model";
    },
  ],
] as const)("rejects %s while UC remains valid", (_name, mutate) => {
  const proof = deployedProofFixture();
  mutate(proof);
  expect(() => validateDeployedProof(proof)).toThrow();
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
    expect(discoverGeneratedAgentTemplates().map(({ name }) => name)).toContain(
      appName,
    );
    const configuredExperimentId =
      process.env.APPKIT_TRACE_CONFORMANCE_EXPERIMENT_ID ?? "";
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
    const requestBody = {
      input: "Count the words in hello traced world. Use count_words.",
    };
    const expectedTool = {
      name: "count_words tool",
      inputs: { text: "hello traced world" },
      outputs: { text: "hello traced world", word_count: 3 },
    };
    const response = await fetch(
      process.env.APPKIT_TRACE_CONFORMANCE_URL ?? "",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MLflow-Return-Trace-Id": "true",
        },
        body: JSON.stringify(requestBody),
      },
    );
    expect(response.ok).toBe(true);
    const responseBody = await response.json();
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
          `/api/2.0/mlflow/experiments/get?experiment_id=${encodeURIComponent(configuredExperimentId)}`,
          "-p",
          profile,
        ],
        { encoding: "utf8" },
      ),
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
    const traceRecord = (storedTrace?.trace ??
      storedTrace) as DeployedTraceProof["traceRecord"];
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
            statement: persistedSpanStatement,
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
    const rows: UcSpanRow[] = (completedSql.result?.data_array ?? []).map(
      (row) => ({
        traceId: row[0],
        spanId: row[1],
        parentSpanId: row[2],
        name: row[3],
        attributes: objectValue(row[4]),
        statusCode: row[5],
        startTimeUnixNano: row[6],
        endTimeUnixNano: row[7],
      }),
    );
    validateDeployedProof({
      appName,
      configuredExperimentId,
      requestBody,
      responseBody,
      expectedTool,
      returnedTraceId: traceId ?? "",
      binding,
      experiment,
      traceRecord,
      rows,
    });
  },
  180_000,
);
