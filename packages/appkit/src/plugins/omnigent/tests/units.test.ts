import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  defineTool,
  toolsFromRegistry,
} from "../../../core/agent/tools/define-tool";
import { buildBundle } from "../bundle";
import { offerHarnesses } from "../harnesses";
import { MCP_KEY_HEADER, MCP_USER_HEADER, SessionKeys } from "../keys";
import { isWriteTool, McpToolServer, mcpToolName } from "../mcp-server";
import { modeFromPolicies, modePolicies } from "../policies";
import { childEnv, profileFor, writeUserConfig } from "../runtime/env";
import { HarnessSandbox } from "../runtime/sandbox";

function untar(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf
      .subarray(off, off + 100)
      .toString()
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(
      buf
        .subarray(off + 124, off + 136)
        .toString()
        .replace(/\0.*$/s, ""),
      8,
    );
    out[name] = buf.subarray(off + 512, off + 512 + size).toString();
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("SessionKeys", () => {
  test("a minted key verifies for its user only", () => {
    const keys = new SessionKeys("secret");
    const k = keys.mint("Alice@Example.com");
    expect(keys.verify(keys.headers(k))).toBe("Alice@Example.com");
    expect(
      keys.verify({ ...keys.headers(k), [MCP_USER_HEADER]: "bob@example.com" }),
    ).toBeNull();
    expect(
      keys.verify({ ...keys.headers(k), [MCP_KEY_HEADER]: "x".repeat(43) }),
    ).toBeNull();
    expect(keys.verify({})).toBeNull();
  });

  test("keys survive a restart when the secret is stable", () => {
    const k = new SessionKeys("stable").mint("a@b.c");
    expect(
      new SessionKeys("stable").verify(new SessionKeys("stable").headers(k)),
    ).toBe("a@b.c");
    expect(
      new SessionKeys("other").verify(new SessionKeys("stable").headers(k)),
    ).toBeNull();
  });
});

describe("policies", () => {
  test("ask gates write tools and OS tools", () => {
    const p = modePolicies("ask", ["save_note"]);
    expect(p.map((x) => x.name)).toEqual(["appkit-mode-ask", "appkit-mode-os"]);
    expect(String(p[0].factory_params?.expression)).toContain(
      'endsWith("save_note")',
    );
    expect(String(p[0].factory_params?.expression)).toContain('"ASK"');
  });

  test("read denies writes; auto has no policies", () => {
    expect(
      String(modePolicies("read", ["w"])[0].factory_params?.expression),
    ).toContain('"DENY"');
    expect(modePolicies("auto", ["w"])).toEqual([]);
  });

  test("no write tools means the gate allows everything", () => {
    expect(modePolicies("ask", [])[0].factory_params?.expression).toBe(
      '{"result": "ALLOW"}',
    );
  });

  test("mode round-trips through policy names", () => {
    for (const m of ["ask", "read", "auto"] as const) {
      expect(modeFromPolicies(modePolicies(m, ["w"]).map((p) => p.name))).toBe(
        m,
      );
    }
  });
});

describe("buildBundle", () => {
  test("writes spec, instructions and one file per MCP server", () => {
    const files = untar(
      gunzipSync(
        buildBundle({
          name: "appkit",
          harness: "codex",
          model: "system.ai.gpt-5-5",
          profile: profileFor("codex"),
          instructions: "Be terse.",
          mcpServers: [
            {
              name: "app",
              url: "http://127.0.0.1:8000/api/omnigent/mcp",
              headers: { a: "b" },
            },
          ],
        }),
      ),
    );
    expect(Object.keys(files).sort()).toEqual([
      "AGENTS.md",
      "config.yaml",
      "tools/mcp/app.yaml",
    ]);
    const cfg = JSON.parse(files["config.yaml"]);
    expect(cfg.executor).toMatchObject({
      model: "system.ai.gpt-5-5",
      profile: "appkit-omnigent-http",
      config: { harness: "codex" },
      auth: { type: "databricks", profile: "appkit-omnigent-http" },
    });
    expect(JSON.parse(files["tools/mcp/app.yaml"])).toMatchObject({
      transport: "http",
      headers: { a: "b" },
    });
    expect(files["AGENTS.md"]).toBe("Be terse.");
  });

  test("rejects unsafe MCP server names", () => {
    expect(() =>
      buildBundle({
        name: "a",
        harness: "pi",
        model: "m",
        profile: "p",
        instructions: "",
        mcpServers: [{ name: "../x", url: "u" }],
      }),
    ).toThrow(/Invalid MCP server name/);
  });

  test("Claude and Pi use the https profile, Codex the http one", () => {
    expect(profileFor("claude-sdk")).toBe("appkit-omnigent");
    expect(profileFor("pi")).toBe("appkit-omnigent");
    expect(profileFor("codex")).toBe("appkit-omnigent-http");
  });
});

describe("McpToolServer", () => {
  const registry = {
    "notes.save": defineTool({
      description: "Save a note",
      schema: z.object({ text: z.string() }),
      annotations: { effect: "write" },
      execute: async ({ text }) => ({ saved: text }),
    }),
    boom: defineTool({
      description: "Fails",
      schema: z.object({}),
      execute: async () => {
        throw new Error("nope");
      },
    }),
  };
  const server = new McpToolServer(() =>
    toolsFromRegistry(registry).map((definition) => ({
      name: mcpToolName(definition.name),
      definition,
      run: async (args) =>
        (registry as Record<string, { execute: (a: never) => unknown }>)[
          definition.name
        ].execute(args as never),
    })),
  );

  test("initialize echoes the client's protocol version", async () => {
    const r = (await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    })) as any;
    expect(r.result.protocolVersion).toBe("2025-11-25");
    expect(r.result.capabilities.tools).toBeDefined();
  });

  test("tools/list uses MCP-safe names and marks writes", async () => {
    const r = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as any;
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["notes_save", "boom"]);
    expect(r.result.tools[0].annotations.readOnlyHint).toBe(false);
    expect(r.result.tools[1].annotations.readOnlyHint).toBe(true);
  });

  test("tools/call returns results and tool errors as isError", async () => {
    const ok = (await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "notes_save", arguments: { text: "hi" } },
    })) as any;
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ saved: "hi" });
    const bad = (await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom" },
    })) as any;
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("nope");
  });

  test("notifications get no reply; unknown methods and tools are errors", async () => {
    expect(
      await server.handle({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
    expect(
      ((await server.handle({ jsonrpc: "2.0", id: 5, method: "nope" })) as any)
        .error.code,
    ).toBe(-32601);
    expect(
      (
        (await server.handle({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "x" },
        })) as any
      ).error.code,
    ).toBe(-32602);
  });

  test("rejects JSON-RPC batches (not part of MCP)", async () => {
    const r = (await server.handle([
      { jsonrpc: "2.0", id: 7, method: "ping" },
    ])) as any;
    expect(r.error.code).toBe(-32600);
  });

  test("isWriteTool honours effect and the deprecated flags", () => {
    const def = (annotations: object) =>
      ({ name: "t", description: "", parameters: {}, annotations }) as any;
    expect(isWriteTool(def({ effect: "destructive" }))).toBe(true);
    expect(isWriteTool(def({ effect: "read" }))).toBe(false);
    expect(isWriteTool(def({ destructive: true }))).toBe(true);
    expect(isWriteTool(def({}))).toBe(false);
  });

  test("mcpToolName prefixes plugin tools and stays within 64 chars", () => {
    expect(mcpToolName("default.sendMessage", "genie")).toBe(
      "genie__default_sendMessage",
    );
    expect(mcpToolName("x".repeat(100))).toHaveLength(64);
  });
});

describe("child environment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  const gw = {
    httpsUrl: "https://127.0.0.1:1",
    httpUrl: "http://127.0.0.1:2",
    placeholder: "appkit-omnigent-ph",
  };

  test("no credential reaches a child", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        DATABRICKS_CLIENT_ID: "id",
        DATABRICKS_CLIENT_SECRET: "secret",
        DATABRICKS_TOKEN: "dapi",
        DATABRICKS_CONFIG_PROFILE: "prod",
        PGPASSWORD: "pw",
        CLAUDECODE: "1",
        NODE_OPTIONS: "--require x",
        KEEP_ME: "yes",
      },
      {
        home: "/h",
        dataDir: "/d",
        gateway: gw,
        caBundle: "/b",
        caCert: "/c",
        pathPrepend: ["/venv/bin"],
      },
    );
    const leaked = Object.values(env).filter((v) => /secret|dapi|pw/.test(v));
    expect(leaked).toEqual([]);
    for (const k of [
      "DATABRICKS_CLIENT_ID",
      "DATABRICKS_CONFIG_PROFILE",
      "CLAUDECODE",
      "NODE_OPTIONS",
    ]) {
      expect(env[k]).toBeUndefined();
    }
    expect(env).toMatchObject({
      DATABRICKS_HOST: gw.httpsUrl,
      HOME: "/h",
      KEEP_ME: "yes",
      SSL_CERT_FILE: "/b",
    });
    expect(env.PATH).toBe(`/venv/bin${path.delimiter}/usr/bin`);
  });

  test("extra can add and remove variables", () => {
    const env = childEnv(
      { A: "1" },
      {
        home: "/h",
        dataDir: "/d",
        gateway: gw,
        caBundle: "",
        caCert: "",
        pathPrepend: [],
        extra: { A: undefined, B: "2" },
      },
    );
    expect(env.A).toBeUndefined();
    expect(env.B).toBe("2");
  });

  test("user config holds only the placeholder", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-home-"));
    dirs.push(home);
    writeUserConfig(home, gw);
    const cfg = fs.readFileSync(path.join(home, ".databrickscfg"), "utf8");
    expect(cfg).toContain(`host = ${gw.httpsUrl}`);
    expect(cfg).toContain(`host = ${gw.httpUrl}`);
    expect(cfg.match(/token = (.*)/g)).toEqual([
      `token = ${gw.placeholder}`,
      `token = ${gw.placeholder}`,
    ]);
    expect(
      (fs.statSync(path.join(home, ".databrickscfg")).mode & 0o777).toString(8),
    ).toBe("600");
    const omni = fs.readFileSync(
      path.join(home, ".config", "omnigent", "config.yaml"),
      "utf8",
    );
    expect(omni).toContain("profile: appkit-omnigent");
  });
});

describe("offerHarnesses", () => {
  const catalog = [
    {
      name: "system.ai.claude-sonnet-5",
      apiTypes: ["mlflow/v1/chat/completions", "anthropic/v1/messages"],
    },
    {
      name: "system.ai.gpt-5-5",
      apiTypes: [
        "mlflow/v1/chat/completions",
        "openai/v1/responses",
        "codex/v1/responses",
      ],
    },
    {
      name: "system.ai.gemini-3-5-flash",
      apiTypes: ["mlflow/v1/chat/completions", "gemini/v1/generateContent"],
    },
    {
      name: "system.ai.glm-5-3",
      apiTypes: [
        "mlflow/v1/chat/completions",
        "anthropic/v1/messages",
        "codex/v1/responses",
      ],
    },
    {
      name: "system.ai.grok-4-7",
      apiTypes: ["mlflow/v1/chat/completions", "openai/v1/responses"],
    },
  ];
  const all = {
    "claude-sdk": true,
    codex: true,
    pi: "needs-auth",
    "openai-agents": true,
  } as const;

  test("matches UC models to harnesses by the API each harness calls", () => {
    const offers = offerHarnesses({
      allowed: Object.keys(all),
      configured: all,
      shellAllowed: true,
      models: catalog,
    });
    const by = Object.fromEntries(offers.map((o) => [o.id, o]));
    expect(by["claude-sdk"].models).toEqual([
      "system.ai.claude-sonnet-5",
      "system.ai.glm-5-3",
    ]);
    expect(by.codex.models).toEqual(["system.ai.gpt-5-5", "system.ai.glm-5-3"]);
    expect(by["openai-agents"].models).toEqual([
      "system.ai.gpt-5-5",
      "system.ai.grok-4-7",
    ]);
    // Pi: the Codex responses API only, and never Claude
    expect(by.pi.models).toEqual(["system.ai.gpt-5-5", "system.ai.glm-5-3"]);
    expect(by["claude-sdk"].defaultModel).toBe("system.ai.claude-sonnet-5");
    expect(by.codex.defaultModel).toBe("system.ai.gpt-5-5");
  });

  test("offers only gateway harnesses", () => {
    const offers = offerHarnesses({
      allowed: ["claude-sdk", "cursor"],
      configured: { "claude-sdk": true, cursor: true },
      shellAllowed: true,
      models: catalog,
    });
    expect(offers.map((o) => o.id)).toEqual(["claude-sdk"]);
  });

  test("drops missing binaries and, without a sandbox, shell harnesses", () => {
    const offers = offerHarnesses({
      allowed: ["claude-sdk", "codex", "pi"],
      configured: { "claude-sdk": true, codex: true, pi: "binary-missing" },
      shellAllowed: false,
      models: catalog,
    });
    expect(offers.map((o) => o.id)).toEqual(["claude-sdk"]);
  });
});

describe("HarnessSandbox", () => {
  test("wrapper masks the runtime root and protected pids, and binds only the user's dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sbx-"));
    try {
      const sbx = new HarnessSandbox(root, "/usr/bin/bwrap");
      sbx.protect([1234, undefined, 1234, 99]);
      expect(fs.readFileSync(path.join(root, "protected.pids"), "utf8")).toBe(
        "1234\n99\n",
      );
      const wrapper = sbx.wrap("codex", "/app/node_modules/codex");
      // named like the CLI, in the shim dir that goes first on PATH
      expect(wrapper).toBe(path.join(sbx.shimDir, "codex"));
      const script = fs.readFileSync(wrapper, "utf8");
      expect(script).toContain(`--tmpfs '${root}'`);
      expect(script).toContain("--unshare-pid");
      expect(script).toContain("--tmpfs /proc/$p");
      expect(script).toContain('--bind "$U" "$U" --bind "$W" "$W"');
      expect(script).toContain("-- '/app/node_modules/codex' \"$@\"");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
