import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { runInCallerContext } from "../../context";
import { createMockWorkspaceClient } from "../../testing";
import { ExecutionSpanProcessor } from "../execution-span-processor";

test("records app and caller identity on every span without tokens", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new ExecutionSpanProcessor(),
      new SimpleSpanProcessor(exporter),
    ],
  });
  const tracer = provider.getTracer("identity");
  tracer.startSpan("app", {}, ROOT_CONTEXT).end();
  await Promise.all(
    ["alice", "bob"].map((userId) =>
      runInCallerContext(
        {
          principal: { type: "user", userId },
          client: createMockWorkspaceClient(),
          workspaceId: Promise.resolve("workspace"),
          tokenFingerprint: "fingerprint-not-for-spans",
        },
        async () => {
          await Promise.resolve();
          for (const name of [
            "plugin.execute",
            "tool.execute",
            "cache.getOrExecute",
            "connector.request",
          ])
            tracer.startSpan(`${userId}:${name}`).end();
        },
      ),
    ),
  );
  const spans = exporter.getFinishedSpans();
  expect(spans[0].attributes).toEqual({
    "appkit.execution.principal": "app",
    "appkit.execution.principal_id": "app",
  });
  for (const span of spans.slice(1)) {
    const userId = span.name.split(":")[0];
    expect(span.attributes).toEqual({
      "appkit.execution.principal": "user",
      "appkit.execution.principal_id": userId,
      "appkit.execution.actor_id": userId,
    });
  }
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain(
    "fingerprint",
  );
  await provider.shutdown();
});
