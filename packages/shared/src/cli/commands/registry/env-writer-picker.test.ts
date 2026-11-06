import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResourceRequirementRow } from "./requirements";

const select = vi.fn();
vi.mock("@clack/prompts", () => ({
  select: (opts: unknown) => select(opts),
  isCancel: () => false,
}));

const listStep = vi.fn();
vi.mock("./workspace-picker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-picker")>()),
  listParentContextStep: (...args: unknown[]) => listStep(...args),
}));

const { syncEnv } = await import("./env-writer");

const MODEL_SERVICE_ROW: ResourceRequirementRow = {
  type: "model_service",
  required: false,
  fields: [
    { key: "name", env: "DATABRICKS_MODEL_SERVICE_NAME", origin: "user" },
  ],
};

const LEVELS: Record<string, { key: string; values: string[] }> = {
  "": { key: "catalog", values: ["main", "system"] },
  main: { key: "schema", values: ["default"] },
  "system.ai": { key: "model service", values: ["system.ai.gpt-5-mini"] },
  "main.default": { key: "model service", values: ["main.default.chat"] },
};

function stepFor(_type: string, _i: number, parents: string[]) {
  const level = LEVELS[parents.join(".")];
  return {
    key: level.key,
    choices: level.values.map((value) => ({ value, label: value })),
  };
}

async function pick(
  answers: string[],
  values?: Record<string, string>,
): Promise<string | undefined> {
  select.mockReset();
  for (const a of answers) select.mockResolvedValueOnce(a);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "env-picker-"));
  try {
    const [res] = await syncEnv([MODEL_SERVICE_ROW], {
      cwd,
      nonInteractive: false,
      values,
    });
    return res?.value;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("model_service picker", () => {
  beforeEach(() => {
    listStep.mockReset();
    listStep.mockImplementation(stepFor);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("opens on system.ai model services", async () => {
    expect(await pick(["system.ai.gpt-5-mini"])).toBe("system.ai.gpt-5-mini");
    expect(listStep).toHaveBeenCalledTimes(1);
    expect(listStep.mock.calls[0].slice(0, 3)).toEqual([
      "model_service",
      2,
      ["system", "ai"],
    ]);
    const labels = select.mock.calls[0][0].options.map(
      (o: { label: string }) => o.label,
    );
    expect(labels).toContain("Browse other catalogs...");
  });

  it("browses into the full catalog/schema drill-down", async () => {
    expect(
      await pick(["__browse__", "main", "default", "main.default.chat"]),
    ).toBe("main.default.chat");
  });

  it("takes any catalog.schema.name from --set without listing", async () => {
    const name = "anthony_ivan.unity_aigw_models.chat";
    expect(await pick([], { DATABRICKS_MODEL_SERVICE_NAME: name })).toBe(name);
    expect(listStep).not.toHaveBeenCalled();
  });
});
