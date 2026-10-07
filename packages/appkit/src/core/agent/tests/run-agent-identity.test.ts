import { createHash } from "node:crypto";

import type {
  AgentAdapter,
  AgentToolDefinition,
  PluginConstructor,
} from "shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  getCallerContext,
  getCurrentPrincipalKey,
  runInCallerContext,
  ServiceContext,
} from "../../../context";
import { createMockWorkspaceClient } from "../../../testing";
import * as workspace from "../../../workspace-client";
import { createAgent } from "../create-agent";
import { runAgent, type RunAgentInput } from "../run-agent";
import { tool } from "../tools/tool";

afterEach(() => vi.restoreAllMocks());

const credentials = (userId: string): NonNullable<RunAgentInput["caller"]> => ({
  token: `token-${userId}`,
  principal: { type: "user", userId },
  host: "https://workspace.example.com",
  workspaceId: "workspace",
});

const probe: AgentAdapter = {
  async *run(_input, ctx) {
    await Promise.resolve();
    const values = [getCurrentPrincipalKey()];
    for (const name of _input.tools?.map((t) => t.name) ?? []) {
      values.push(String(await ctx.executeTool(name, {})));
    }
    yield { type: "message_delta", content: values.join("/") };
  },
};

describe("standalone caller identity", () => {
  test("defaults to SP and inherits a caller without widening", async () => {
    const def = createAgent({ instructions: "identity", model: probe });
    expect((await runAgent(def, { messages: "hi" })).text).toBe("app");
    const caller = {
      principal: { type: "user" as const, userId: "alice" },
      client: createMockWorkspaceClient(),
      workspaceId: Promise.resolve("workspace"),
    };
    expect(
      (
        await runInCallerContext(caller, () =>
          runAgent(def, { messages: "hi" }),
        )
      ).text,
    ).toBe("user:alice");
    expect(getCurrentPrincipalKey()).toBe("app");
  });

  test("scopes setup, adapters, inline tools, plugin tools, and sub-agents without service initialization", async () => {
    const client = createMockWorkspaceClient();
    const factory = vi
      .spyOn(workspace, "createWorkspaceClient")
      .mockReturnValue(client);
    expect(ServiceContext.isInitialized()).toBe(false);
    const seen: string[] = [];
    class Provider {
      name = "identity";
      async setup() {
        seen.push(getCurrentPrincipalKey());
      }
      getAgentTools(): AgentToolDefinition[] {
        return [
          {
            name: "read",
            description: "identity",
            parameters: { type: "object" },
          },
        ];
      }
      async executeAgentTool() {
        return getCurrentPrincipalKey();
      }
    }
    const inline = tool({
      name: "inline",
      description: "identity",
      schema: z.object({}),
      execute: async () => {
        const caller = getCallerContext();
        expect(caller?.client).toBe(client);
        expect(caller?.tokenFingerprint).toBe(
          createHash("sha256").update("token-alice").digest("hex").slice(0, 16),
        );
        return getCurrentPrincipalKey();
      },
    });
    const def = createAgent({
      instructions: "identity",
      model: probe,
      tools: (plugins) => ({ ...plugins.identity.toolkit(), inline }),
      agents: { child: createAgent({ instructions: "child", model: probe }) },
    });
    const result = await runAgent(def, {
      messages: "hi",
      caller: credentials("alice"),
      plugins: [
        {
          name: "identity",
          config: {},
          plugin: Provider as unknown as PluginConstructor,
        },
      ],
    });
    expect(result.text).toBe("user:alice/user:alice/user:alice/user:alice");
    expect(seen).toEqual(["user:alice"]);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ token: "token-alice", authType: "pat" }),
    );
    expect(JSON.stringify(result)).not.toContain("token-alice");
    expect(getCurrentPrincipalKey()).toBe("app");
    expect(ServiceContext.isInitialized()).toBe(false);
  });

  test("isolates concurrent injected users and restores context on failure", async () => {
    vi.spyOn(workspace, "createWorkspaceClient").mockReturnValue(
      createMockWorkspaceClient(),
    );
    const def = createAgent({ instructions: "identity", model: probe });
    const results = await Promise.all(
      ["alice", "bob"].map((user) =>
        runAgent(def, { messages: "hi", caller: credentials(user) }),
      ),
    );
    expect(results.map((r) => r.text)).toEqual(["user:alice", "user:bob"]);
    const failure = createAgent({
      instructions: "fail",
      model: {
        async *run() {
          yield { type: "message_delta", content: "" };
          throw new Error("failed");
        },
      },
    });
    await expect(
      runAgent(failure, { messages: "hi", caller: credentials("alice") }),
    ).rejects.toThrow("failed");
    expect(getCallerContext()).toBeUndefined();
  });

  test("rejects incomplete explicit credentials even in development", async () => {
    const factory = vi.spyOn(workspace, "createWorkspaceClient");
    const def = createAgent({ instructions: "identity", model: probe });
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const caller of [
        { ...credentials("alice"), token: " " },
        credentials(" "),
        { ...credentials("alice"), host: "" },
        { ...credentials("alice"), workspaceId: "" },
      ])
        await expect(
          runAgent(def, { messages: "hi", caller }),
        ).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an on-behalf-of-user agent rejects a run without a caller", async () => {
    const run = vi.fn(probe.run);
    const def = createAgent({
      instructions: "identity",
      model: { run },
      auth: "on-behalf-of-user",
    });
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /user token/,
    );
    expect(run).not.toHaveBeenCalled();
    expect(
      (await runAgent(def, { messages: "hi", caller: credentials("alice") }))
        .text,
    ).toBe("user:alice");
  });

  test("a string model runs on the caller's client, and a mixed sub-agent never widens", async () => {
    const used: string[] = [];
    const real = workspace.createWorkspaceClient;
    vi.spyOn(workspace, "createWorkspaceClient").mockImplementation(
      (options) => {
        const client = real(options);
        const caller = options?.token ? "user" : "app";
        client.request = (async () => {
          used.push(caller);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }) as never;
        return client;
      },
    );
    const child = createAgent({ instructions: "child", model: "my-endpoint" });
    const delegate: AgentAdapter = {
      async *run(_input, ctx) {
        yield {
          type: "message_delta",
          content: String(
            await ctx.executeTool("agent-child", { input: "go" }),
          ),
        };
      },
    };
    const parent = (auth?: "on-behalf-of-user") =>
      createAgent({
        instructions: "parent",
        model: delegate,
        agents: { child },
        ...(auth && { auth }),
      });
    const caller = credentials("alice");
    await runAgent(parent("on-behalf-of-user"), { messages: "hi", caller });
    await runAgent(parent(), { messages: "hi", caller });
    expect(used).toEqual(["user", "app"]);
  });
});
