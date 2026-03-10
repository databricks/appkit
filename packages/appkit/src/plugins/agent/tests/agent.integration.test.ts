import type { Server } from "node:http";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

process.env.DATABRICKS_APP_PORT = "8000";
process.env.FLASK_RUN_HOST = "0.0.0.0";
process.env.DATABRICKS_MODEL = "test-model";

import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { server as serverPlugin } from "../../server/index";
import { agent } from "../agent";
import { StubAgent } from "./stub-agent";

function parseSSEStream(text: string) {
  const events: any[] = [];
  let fullOutput = "";
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      try {
        const data = JSON.parse(line.slice(6));
        events.push(data);
        if (data.type === "response.output_text.delta") {
          fullOutput += data.delta;
        }
      } catch {}
    }
  }
  return { events, fullOutput };
}

describe("AgentPlugin Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9885;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    const app = await createApp({
      plugins: [
        agent({ agentInstance: new StubAgent() }),
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
      ],
    });

    await app.server.start();
    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    serviceContextMock?.restore();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  describe("POST /api/agent (streaming)", () => {
    test("streams SSE events and completes", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ role: "user", content: "Hello agent" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );

      const text = await response.text();
      const { events, fullOutput } = parseSSEStream(text);

      expect(fullOutput).toContain("Echo: Hello agent");

      const hasCompleted = events.some((e) => e.type === "response.completed");
      expect(hasCompleted).toBe(true);

      expect(text).toContain("data: [DONE]");
    });
  });

  describe("non-streaming mode", () => {
    test("returns JSON response", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ role: "user", content: "No stream" }],
          stream: false,
        }),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as {
        output: { type: string; content: { text: string }[] }[];
      };

      expect(data.output).toBeDefined();
      expect(data.output).toHaveLength(1);
      expect(data.output[0].type).toBe("message");
      expect(data.output[0].content[0].text).toContain("Echo: No stream");
    });
  });

  describe("string input", () => {
    test("accepts plain string as input", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: "Plain string input",
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);
      const text = await response.text();
      const { fullOutput } = parseSSEStream(text);
      expect(fullOutput).toContain("Echo: Plain string input");
    });
  });

  describe("multi-turn conversations", () => {
    test("handles chat history", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [
            { role: "user", content: "My name is Alice" },
            {
              role: "assistant",
              content: "Nice to meet you, Alice",
            },
            {
              role: "user",
              content: "What is my name?",
            },
          ],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);
      const text = await response.text();
      const { fullOutput } = parseSSEStream(text);
      expect(fullOutput).toContain("Echo: What is my name?");
    });

    test("handles function_call items in history", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [
            { role: "user", content: "Look up the answer" },
            {
              type: "function_call",
              name: "search",
              arguments: '{"q":"test"}',
            },
            {
              type: "function_call_output",
              output: '"42"',
            },
            {
              role: "user",
              content: "What did you find?",
            },
          ],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);
      const text = await response.text();
      const { fullOutput } = parseSSEStream(text);
      expect(fullOutput.length).toBeGreaterThan(0);
    });
  });

  describe("error responses", () => {
    test("returns 400 for malformed input", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
    });

    test("returns 400 when no user message", async () => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ role: "assistant", content: "Only assistant" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
    });
  });
});
