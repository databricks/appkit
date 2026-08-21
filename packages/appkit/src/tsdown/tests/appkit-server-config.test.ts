import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appkitServerConfig } from "../index";

describe("appkitServerConfig", () => {
  it("adds the agent glob + clean when code agents exist", () => {
    const c = appkitServerConfig({}, { codeAgents: true });
    expect(c.entry).toEqual(["server/server.ts", "server/agents/*/agent.ts"]);
    expect(c.clean).toBe(true);
    expect(c.unbundle).toBe(true);
  });

  it("omits the agent glob + clean when there are no code agents", () => {
    const c = appkitServerConfig({}, { codeAgents: false });
    expect(c.entry).toEqual(["server/server.ts"]);
    expect(c.clean).toBeUndefined();
  });

  it("unions user entries — the agent glob survives an entry override", () => {
    const c = appkitServerConfig(
      { entry: "server/worker.ts" },
      { codeAgents: true },
    );
    expect(c.entry).toEqual([
      "server/server.ts",
      "server/agents/*/agent.ts",
      "server/worker.ts",
    ]);
  });

  it("composes external instead of clobbering AppKit's", () => {
    const c = appkitServerConfig(
      { external: (id) => id === "keepme" },
      { codeAgents: true },
    );
    const ext = c.external as (id: string) => boolean;
    expect(ext("keepme")).toBe(true); // caller's rule
    expect(ext("express")).toBe(true); // AppKit default (bare specifier)
    expect(ext("./local")).toBe(false); // neither → bundled
  });

  it("passes through unrelated overrides while protecting entry", () => {
    const c = appkitServerConfig(
      { tsconfig: "tsconfig.custom.json", sourcemap: true },
      { codeAgents: true },
    );
    expect(c.tsconfig).toBe("tsconfig.custom.json");
    expect(c.sourcemap).toBe(true);
    expect(c.entry).toContain("server/agents/*/agent.ts");
  });

  it("hands the computed base to a function override for full control", () => {
    const c = appkitServerConfig(
      (base) => ({ ...base, entry: ["only/this.ts"], unbundle: false }),
      { codeAgents: true },
    );
    // The function form can override even the protected fields.
    expect(c.entry).toEqual(["only/this.ts"]);
    expect(c.unbundle).toBe(false);
  });

  describe("code-agent auto-detection (fs)", () => {
    let tmp: string;
    const mk = (rel: string) => {
      const p = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "");
    };

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-tsdown-"));
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it("detects server/agents/<id>/agent.ts under cwd", () => {
      mk("server/agents/helper/agent.ts");
      expect(appkitServerConfig({}, { cwd: tmp }).entry).toContain(
        "server/agents/*/agent.ts",
      );
    });

    it("does not add the glob when server/agents has no code agent", () => {
      mk("server/agents/planner/agent.md"); // markdown only
      expect(appkitServerConfig({}, { cwd: tmp }).entry).toEqual([
        "server/server.ts",
      ]);
    });
  });
});
