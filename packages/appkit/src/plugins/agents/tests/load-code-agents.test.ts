import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadCodeAgentsFromDir,
  resolveCodeAgentsDir,
} from "../../../core/agent/load-code-agents";

const fixtureDir = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const TS = { extensions: [".ts"] };

describe("loadCodeAgentsFromDir", () => {
  it("returns an empty record when the directory does not exist", async () => {
    expect(
      await loadCodeAgentsFromDir(fixtureDir("does-not-exist"), TS),
    ).toEqual({});
  });

  it("discovers default and named agent exports, id = folder name", async () => {
    const agents = await loadCodeAgentsFromDir(fixtureDir("code-agents"), TS);
    expect(Object.keys(agents).sort()).toEqual(["builder", "helper"]);
    expect(agents.builder.instructions).toBe("I build.");
    expect(agents.helper.instructions).toBe("I help.");
  });

  it("skips folders whose entry file exports no created agent", async () => {
    const agents = await loadCodeAgentsFromDir(fixtureDir("code-agents"), TS);
    // notAnAgent/agent.ts exports a plain constant — must not be registered.
    expect(agents.notAnAgent).toBeUndefined();
  });

  it("skips folders that have no agent entry file (markdown / asset dirs)", async () => {
    // md-parent-code-child/planner has only agent.md; the code loader ignores it.
    const agents = await loadCodeAgentsFromDir(
      fixtureDir("md-parent-code-child"),
      TS,
    );
    expect(Object.keys(agents)).toEqual(["helper"]);
  });

  it("throws when one entry file exports more than one agent", async () => {
    await expect(
      loadCodeAgentsFromDir(fixtureDir("code-agents-multi"), TS),
    ).rejects.toThrow(/exports 2 created agents/);
  });
});

describe("resolveCodeAgentsDir", () => {
  const cwd = "/app";
  const dist = path.resolve(cwd, "dist/agents");
  const build = path.resolve(cwd, "build/agents");
  const source = path.resolve(cwd, "server/agents");
  const existsIn =
    (...present: string[]) =>
    (dir: string) =>
      present.includes(dir);

  it("returns null when discovery is disabled", () => {
    expect(
      resolveCodeAgentsDir({ cwd, override: false, exists: () => true }),
    ).toBeNull();
  });

  it("scans an absolute override verbatim, accepting any module extension", () => {
    expect(
      resolveCodeAgentsDir({
        cwd,
        override: "/abs/agents",
        exists: () => true,
      }),
    ).toEqual({
      dir: "/abs/agents",
      extensions: [".ts", ".tsx", ".js", ".mjs"],
    });
  });

  it("resolves a relative override built-first (dist/<name> over source)", () => {
    const customDist = path.resolve(cwd, "dist/my-agents");
    const customSrc = path.resolve(cwd, "my-agents");
    expect(
      resolveCodeAgentsDir({
        cwd,
        override: "my-agents",
        exists: existsIn(customDist, customSrc),
      }),
    ).toEqual({ dir: customDist, extensions: [".js", ".mjs"] });
    // No built output → falls back to the source `.ts` dir.
    expect(
      resolveCodeAgentsDir({ cwd, override: "my-agents", exists: () => false }),
    ).toEqual({ dir: customSrc, extensions: [".ts"] });
  });

  it("stays built-first when dir is set to the default value explicitly", () => {
    // Regression: `agents({ dir: "server/agents" })` must NOT bypass built-first
    // (previously a string override was scanned verbatim → prod loaded .ts).
    const r = resolveCodeAgentsDir({
      cwd,
      override: "server/agents",
      exists: existsIn(dist, source),
    });
    expect(r).toEqual({ dir: dist, extensions: [".js", ".mjs"] });
  });

  it("prefers compiled dist/agents (.js) over source — built wins", () => {
    const r = resolveCodeAgentsDir({ cwd, exists: existsIn(dist, source) });
    expect(r).toEqual({ dir: dist, extensions: [".js", ".mjs"] });
  });

  it("falls back to build/agents when dist/agents is absent", () => {
    const r = resolveCodeAgentsDir({ cwd, exists: existsIn(build, source) });
    expect(r).toEqual({ dir: build, extensions: [".js", ".mjs"] });
  });

  it("uses server/agents (.ts) only when no built dir exists", () => {
    const r = resolveCodeAgentsDir({ cwd, exists: existsIn(source) });
    expect(r).toEqual({ dir: source, extensions: [".ts"] });
  });

  it("targets server/agents when nothing exists (empty scan downstream)", () => {
    const r = resolveCodeAgentsDir({ cwd, exists: () => false });
    expect(r).toEqual({ dir: source, extensions: [".ts"] });
  });
});
