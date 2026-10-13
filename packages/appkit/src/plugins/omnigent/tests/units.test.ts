import { gunzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { buildBundle } from "../bundle";
import { offerHarnesses } from "../harnesses";

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
