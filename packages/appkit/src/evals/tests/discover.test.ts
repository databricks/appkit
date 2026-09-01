import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  discoverEvalConfigs,
  discoverEvalFiles,
  findRootEvalConfig,
} from "../discover";

let root: string;

function write(rel: string, content = "export default {}") {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "appkit-evals-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverEvalFiles", () => {
  test("finds *.eval.ts per agent, derives id + agent, ignores non-evals", () => {
    write("server/agents/support/evals/basic.eval.ts");
    write("server/agents/support/evals/nested/deep.eval.ts");
    write("server/agents/support/evals/evals.config.ts");
    write("server/agents/analyst/evals/sql.eval.ts");
    write("server/agents/no-evals/agent.md", "# agent");

    const found = discoverEvalFiles(root);

    expect(found.map((f) => `${f.agent}/${f.id}`)).toEqual([
      "analyst/sql",
      "support/basic",
      "support/nested/deep",
    ]);
  });

  test("returns empty when there is no server/agents dir", () => {
    expect(discoverEvalFiles(root)).toEqual([]);
  });
});

describe("discoverEvalConfigs", () => {
  test("finds each agent's evals.config.ts, omits agents without one", () => {
    write("server/agents/support/evals/basic.eval.ts");
    write("server/agents/support/evals/evals.config.ts");
    write("server/agents/analyst/evals/sql.eval.ts");

    const found = discoverEvalConfigs(root);

    expect(found.map((c) => c.agent)).toEqual(["support"]);
    expect(found[0].file).toBe(
      path.join(root, "server/agents/support/evals/evals.config.ts"),
    );
  });

  test("returns empty when there is no server/agents dir", () => {
    expect(discoverEvalConfigs(root)).toEqual([]);
  });
});

describe("findRootEvalConfig", () => {
  test("finds a root evals.config.ts", () => {
    write("evals.config.ts");
    expect(findRootEvalConfig(root)).toBe(path.join(root, "evals.config.ts"));
  });

  test("returns undefined when absent (and ignores per-agent configs)", () => {
    write("server/agents/support/evals/evals.config.ts");
    expect(findRootEvalConfig(root)).toBeUndefined();
  });
});
