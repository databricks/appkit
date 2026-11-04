import { gunzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { buildBundle } from "../bundle";
import { offerHarnesses } from "../harnesses";
import { modeFromPolicies, modePolicies } from "../policies";
import { toolServer, writeToolNames } from "../tools";

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

describe("buildBundle", () => {
  test("writes the spec and the instructions", () => {
    const files = untar(
      gunzipSync(
        buildBundle({
          name: "orders-app",
          harness: "pi",
          model: "system.ai.gpt-5-5",
          instructions: "Be terse.",
        }),
      ),
    );
    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "config.yaml"]);
    expect(JSON.parse(files["config.yaml"]).executor).toEqual({
      type: "omnigent",
      model: "system.ai.gpt-5-5",
      config: { harness: "pi" },
    });
    expect(files["AGENTS.md"]).toBe("Be terse.");
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

  test("matches UC models to harnesses by the API each harness calls", () => {
    const offers = offerHarnesses({
      allowed: ["claude-sdk", "pi", "openai-agents"],
      models: catalog,
    });
    const by = Object.fromEntries(offers.map((o) => [o.id, o]));
    expect(by["claude-sdk"].models).toEqual([
      "system.ai.claude-sonnet-5",
      "system.ai.glm-5-3",
    ]);
    expect(by.pi.models).toEqual(["system.ai.gpt-5-5", "system.ai.glm-5-3"]);
    expect(by["openai-agents"].models).toEqual([
      "system.ai.gpt-5-5",
      "system.ai.grok-4-7",
    ]);
    expect(by["claude-sdk"].defaultModel).toBe("system.ai.claude-sonnet-5");
    expect(by.pi.defaultModel).toBe("system.ai.gpt-5-5");
  });

  test("offers only gateway harnesses, in the allowed order", () => {
    const offers = offerHarnesses({
      allowed: ["pi", "cursor", "claude-sdk"],
      models: catalog,
    });
    expect(offers.map((o) => o.id)).toEqual(["pi", "claude-sdk"]);
  });
});

describe("tool sources", () => {
  const host = "https://ws.example.com";

  test("each source becomes a stdio proxy to its managed MCP URL", () => {
    const urls = [
      { type: "sql" },
      { type: "genie", spaceId: "01f0abcdef12345678" },
      { type: "functions", catalog: "main", schema: "tools" },
      {
        type: "functions",
        catalog: "main",
        schema: "tools",
        function: "price",
      },
      { type: "ai-search", catalog: "main", schema: "docs", index: "faq" },
      { type: "service", service: "system.ai.web_search" },
    ].map((s) => {
      const spec = toolServer(s as never, host);
      expect(spec).toMatchObject({ transport: "stdio", command: "python3" });
      expect(spec.args[0]).toBe("-c");
      expect(spec.args[1]).toContain("databricks.sdk.core");
      return [spec.name, spec.args[2]];
    });
    expect(urls).toEqual([
      ["sql", `${host}/api/2.0/mcp/sql`],
      ["genie_12345678", `${host}/api/2.0/mcp/genie/01f0abcdef12345678`],
      ["functions_tools", `${host}/api/2.0/mcp/functions/main/tools`],
      [
        "functions_tools_price",
        `${host}/api/2.0/mcp/functions/main/tools/price`,
      ],
      ["search_faq", `${host}/api/2.0/mcp/ai-search/main/docs/faq`],
      [
        "system_ai_web_search",
        `${host}/ai-gateway/mcp-services/system.ai.web_search`,
      ],
    ]);
  });

  test("names can be set and are made MCP-safe", () => {
    expect(toolServer({ type: "sql", name: "Orders DB" }, host).name).toBe(
      "orders_db",
    );
  });

  test("Databricks SQL's execute_sql is a write by default; apps add their own", () => {
    expect(writeToolNames([{ type: "sql" }], ["send_message"])).toEqual([
      "execute_sql",
      "send_message",
    ]);
    expect(writeToolNames([{ type: "genie", spaceId: "x" }])).toEqual([]);
  });

  test("the bundle carries one tools/mcp file per server", () => {
    const files = untar(
      gunzipSync(
        buildBundle({
          name: "orders-app",
          harness: "pi",
          model: "system.ai.gpt-5-5",
          instructions: "",
          mcpServers: [toolServer({ type: "sql" }, host)],
        }),
      ),
    );
    expect(JSON.parse(files["tools/mcp/sql.yaml"])).toMatchObject({
      name: "sql",
      transport: "stdio",
      command: "python3",
    });
    expect(() =>
      buildBundle({
        name: "a",
        harness: "pi",
        model: "m",
        instructions: "",
        mcpServers: [
          toolServer({ type: "sql" }, host),
          toolServer({ type: "sql" }, host),
        ],
      }),
    ).toThrow(/Duplicate MCP server name/);
  });
});

describe("policies", () => {
  test("ask gates write tools and OS tools", () => {
    const p = modePolicies("ask", ["execute_sql"]);
    expect(p.map((x) => x.name)).toEqual(["appkit-mode-ask", "appkit-mode-os"]);
    expect(String(p[0].factory_params?.expression)).toContain(
      'endsWith("execute_sql")',
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
