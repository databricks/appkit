import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentInput, AgentRunContext } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../../cache";
import type { AgentsPluginConfig } from "../../../core/agent/types";
import { AgentsPlugin } from "../agents";

const { adapterFromModelString } = vi.hoisted(() => ({
  adapterFromModelString: vi.fn(),
}));

vi.mock("../../../agents/databricks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/databricks")>()),
  adapterFromModelString,
}));

function stubAdapter(): AgentAdapter {
  return {
    async *run(_input: AgentInput, _ctx: AgentRunContext) {
      yield { type: "message_delta", content: "" };
    },
  };
}

async function setupWithAgentWithoutModel(config: AgentsPluginConfig = {}) {
  const plugin = new AgentsPlugin({
    ...config,
    name: "agent",
    agents: { assistant: { instructions: "You help." } },
  });
  plugin.attachContext({ context: undefined as unknown as object });
  await plugin.setup();
}

let tmpDir: string;
let priorCwd: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-default-model-"));
  priorCwd = process.cwd();
  process.chdir(tmpDir);
  await CacheManager.getInstance({
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      keys: vi.fn(),
      healthCheck: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    } as any,
  });
  adapterFromModelString.mockReset();
  adapterFromModelString.mockResolvedValue(stubAdapter());
  vi.stubEnv("DATABRICKS_MODEL_SERVICE_NAME", "");
  vi.stubEnv("DATABRICKS_SERVING_ENDPOINT_NAME", "");
  delete process.env.DATABRICKS_MODEL_SERVICE_NAME;
  delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(priorCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentsPlugin default model", () => {
  test("uses DATABRICKS_MODEL_SERVICE_NAME before DATABRICKS_SERVING_ENDPOINT_NAME", async () => {
    vi.stubEnv("DATABRICKS_MODEL_SERVICE_NAME", "main.default.my_model");
    vi.stubEnv("DATABRICKS_SERVING_ENDPOINT_NAME", "my-endpoint");

    await setupWithAgentWithoutModel();

    expect(adapterFromModelString).toHaveBeenCalledTimes(1);
    expect(adapterFromModelString.mock.calls[0][0]).toBe(
      "main.default.my_model",
    );
  });

  test("falls back to DATABRICKS_SERVING_ENDPOINT_NAME", async () => {
    vi.stubEnv("DATABRICKS_SERVING_ENDPOINT_NAME", "my-endpoint");

    await setupWithAgentWithoutModel();

    expect(adapterFromModelString.mock.calls[0][0]).toBe("my-endpoint");
  });

  test("config defaultModel wins over both env vars", async () => {
    vi.stubEnv("DATABRICKS_MODEL_SERVICE_NAME", "main.default.my_model");
    vi.stubEnv("DATABRICKS_SERVING_ENDPOINT_NAME", "my-endpoint");

    await setupWithAgentWithoutModel({ defaultModel: "system.ai.claude" });

    expect(adapterFromModelString.mock.calls[0][0]).toBe("system.ai.claude");
  });

  test("errors naming both env vars when no model is available", async () => {
    await expect(setupWithAgentWithoutModel()).rejects.toThrow(
      "DATABRICKS_MODEL_SERVICE_NAME or DATABRICKS_SERVING_ENDPOINT_NAME",
    );
  });
});
