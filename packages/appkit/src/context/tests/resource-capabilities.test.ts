import type { AgentToolDefinition } from "shared";
import { describe, expect, test, vi } from "vitest";

import { createAgent, runAgent } from "../../core/agent";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import {
  createMockRequest,
  createTestApp,
  createTestPluginContext,
  createMockWorkspaceClient,
} from "../../testing";
import {
  getCurrentPrincipalKey,
  runInCallerContext,
  runInUserContext,
} from "../execution-context";
import { assertPluginExecution } from "../resource-capabilities";
import { guardPluginApi } from "../resource-capabilities";

function probe(name: string, type?: string) {
  class ResourceProbe extends Plugin {
    static manifest = defineManifest({
      name,
      displayName: name,
      description: "probe",
      resources: {
        required: type
          ? [
              {
                type,
                alias: "resource",
                resourceKey: "resource",
                description: "probe",
                permission:
                  type === "secret"
                    ? "READ"
                    : type === "sql_warehouse"
                      ? "CAN_USE"
                      : "CAN_CONNECT_AND_CREATE",
                fields: { id: { description: "Test resource" } },
              },
            ]
          : [],
        optional: [],
      },
    });
    getAgentTools(): AgentToolDefinition[] {
      return [
        { name: "read", description: "probe", parameters: { type: "object" } },
      ];
    }
    async executeAgentTool() {
      return "read";
    }
    exports() {
      return { read: () => "read", nested: { read: () => "nested" } };
    }
  }
  return ResourceProbe;
}
const request = () => createMockRequest({ obo: { userId: "alice" } });
const caller = {
  principal: { type: "user" as const, userId: "alice" },
  client: createMockWorkspaceClient(),
  workspaceId: Promise.resolve("workspace"),
};

describe("resource identity contract", () => {
  test("resource guards preserve SP result identity", async () => {
    const AppOnly = probe("appOnly", "postgres");
    const plugin = new AppOnly({});
    const rows = { rows: [{ id: 1 }] };
    const api = guardPluginApi(plugin, {
      read: () => rows,
      asyncRead: async () => rows,
    });
    expect(api.read()).toBe(rows);
    expect(await api.asyncRead()).toBe(rows);
  });
  test.each(["secret", "database", "postgres"])(
    "rejects %s in caller scope but preserves SP and unrelated plugins",
    async (type) => {
      const AppOnly = probe("appOnly", type);
      const ObO = probe("analytics", "sql_warehouse");
      await using app = await createTestApp({
        plugins: [toPlugin(AppOnly)(), toPlugin(ObO)()],
        server: false,
      });
      const cachedRead = app.plugins.appOnly.read;
      expect(cachedRead()).toBe("read");
      expect(app.plugins.appOnly.asUser(request()).read()).toBe("read");
      const scoped = app.plugins.asUser(request());
      expect(() => scoped.appOnly).toThrow(/does not support OBO/);
      expect(scoped.analytics.read()).toBe("read");
      await expect(scoped.run(() => cachedRead())).rejects.toThrow(
        /does not support OBO/,
      );
      await expect(
        scoped.run(() => app.plugins.appOnly.read()),
      ).rejects.toThrow(/does not support OBO/);
      await expect(
        scoped.run(() => app.plugins.appOnly.asUser(request()).read()),
      ).rejects.toThrow(/does not support OBO/);
      await expect(
        scoped.run(() => runInUserContext(caller, () => cachedRead())),
      ).rejects.toThrow(/does not support OBO/);
      expect(app.plugins.appOnly.read()).toBe("read");
    },
  );

  test("keeps app-only, OBO-capable missing-token, and generic messages distinct", async () => {
    const AppOnly = probe("appOnly", "postgres");
    const ObO = probe("analytics", "sql_warehouse");
    const Generic = probe("generic");
    await using app = await createTestApp({
      plugins: [toPlugin(AppOnly)(), toPlugin(ObO)(), toPlugin(Generic)()],
      server: false,
    });
    const missing = createMockRequest();
    expect(() => app.plugins.asUser(request()).appOnly).toThrow(
      "Lakebase does not support OBO",
    );
    expect(() => app.plugins.appOnly.asUser(missing)).toThrow(
      "Missing user token in request headers",
    );
    expect(() => app.plugins.analytics.asUser(missing)).toThrow(
      "OBO-capable but no user token was forwarded",
    );
    expect(() => app.plugins.generic.asUser(missing)).toThrow(
      "Missing user token in request headers",
    );
    expect(() => app.plugins.asUser(missing)).toThrow(
      "likely deployed service-principal-only",
    );
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(app.plugins.asUser(missing).analytics.read()).toBe("read");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("blocks direct and standalone toolkit dispatch before the provider is called", async () => {
    const AppOnly = probe("appOnly", "postgres");
    const execute = vi.spyOn(AppOnly.prototype, "executeAgentTool");
    const mock = createTestPluginContext();
    await mock.attach(new AppOnly({}));
    await expect(
      runInCallerContext(caller, () =>
        mock.ctx.executeTool(request() as never, "appOnly", "read", {}),
      ),
    ).rejects.toThrow(/does not support OBO/);
    const def = createAgent({
      instructions: "probe",
      tools: (plugins) => plugins.appOnly.toolkit(),
      model: {
        async *run(_input, ctx) {
          yield {
            type: "message_delta",
            content: String(await ctx.executeTool("appOnly.read", {})),
          };
        },
      },
    });
    await expect(
      runInCallerContext(caller, () =>
        runAgent(def, { messages: "hi", plugins: [toPlugin(AppOnly)()] }),
      ),
    ).rejects.toThrow(/does not support OBO/);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  test("legacy direct dispatch preserves user identity for existing app-only providers", async () => {
    const AppOnly = probe("appOnly", "postgres");
    const identity = vi
      .spyOn(AppOnly.prototype, "executeAgentTool")
      .mockImplementation(async () => getCurrentPrincipalKey());
    try {
      const mock = createTestPluginContext();
      await mock.attach(new AppOnly({}));
      await expect(
        mock.ctx.executeTool(request(), "appOnly", "read", {}),
      ).resolves.toBe("user:alice");
      identity.mockClear();
      await expect(
        mock.ctx.executeTool(createMockRequest(), "appOnly", "read", {}),
      ).rejects.toThrow(/token/i);
      expect(identity).not.toHaveBeenCalled();
    } finally {
      identity.mockRestore();
    }
  });

  test("does not treat an unbound optional app-only resource as active", () => {
    class Optional extends Plugin {
      static manifest = defineManifest({
        name: "optional",
        displayName: "optional",
        description: "probe",
        resources: {
          required: [],
          optional: [
            {
              type: "secret",
              alias: "secret",
              resourceKey: "secret",
              description: "probe",
              permission: "READ",
              fields: {
                key: { env: "APPKIT_TEST_OPTIONAL_SECRET", description: "key" },
              },
            },
          ],
        },
      });
    }
    const plugin = new Optional({});
    vi.stubEnv("APPKIT_TEST_OPTIONAL_SECRET", "");
    try {
      expect(() => assertPluginExecution(plugin, true)).not.toThrow();
      vi.stubEnv("APPKIT_TEST_OPTIONAL_SECRET", "configured");
      expect(() => assertPluginExecution(plugin, true)).toThrow(
        /Secret does not support OBO/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
