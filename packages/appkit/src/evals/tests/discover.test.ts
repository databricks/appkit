import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverEvalFiles } from "../discover";

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
  test("finds *.eval.ts per agent, derives id + agent, ignores config", () => {
    write("config/agents/support/evals/basic.eval.ts");
    write("config/agents/support/evals/nested/deep.eval.ts");
    write("config/agents/support/evals/evals.config.ts");
    write("config/agents/analyst/evals/sql.eval.ts");
    write("config/agents/no-evals/agent.md", "# agent");

    const found = discoverEvalFiles(root);

    expect(found.map((f) => `${f.agent}/${f.id}`)).toEqual([
      "analyst/sql",
      "support/basic",
      "support/nested/deep",
    ]);
  });

  test("returns empty when there is no config/agents dir", () => {
    expect(discoverEvalFiles(root)).toEqual([]);
  });
});
