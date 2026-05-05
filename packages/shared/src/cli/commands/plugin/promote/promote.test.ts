import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_PATH_MAP,
  isStability,
  PLUGIN_NAME_PATTERN,
  rewriteImportsInFile,
  runPromote,
  TIER_ORDER,
  validatePluginName,
} from "./promote";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "promote-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function writeManifest(
  dir: string,
  name: string,
  stability?: string,
  subdir = "plugins",
): string {
  const pluginDir = path.join(dir, subdir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    $schema:
      "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `Test plugin ${name}`,
    resources: { required: [], optional: [] },
  };
  if (stability !== undefined) manifest.stability = stability;
  const manifestPath = path.join(pluginDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

interface PromoteHarness {
  cwd: string;
  cleanup: () => void;
  errors: string[];
  logs: string[];
}

function setupHarness(): PromoteHarness {
  const tmp = makeTempDir();
  const originalCwd = process.cwd();
  process.chdir(tmp);
  const errors: string[] = [];
  const logs: string[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`__exit:${code ?? 0}`);
  }) as never);
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  return {
    cwd: tmp,
    errors,
    logs,
    cleanup: () => {
      process.chdir(originalCwd);
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
      cleanDir(tmp);
    },
  };
}

describe("validatePluginName", () => {
  it.each([
    "my-plugin",
    "my_plugin",
    "my.plugin",
    "plugin42",
    "@databricks/files",
    "@scope/foo-bar",
  ])("accepts valid name: %s", (name) => {
    expect(() => validatePluginName(name)).not.toThrow();
  });

  it.each([
    ["..", "traversal"],
    ["../etc/passwd", "traversal"],
    ["foo/../bar", "traversal"],
    ["a/b", "unscoped slash"],
    ["foo\0bar", "null byte"],
    ["", "empty"],
    ["plugin name", "space"],
    ["@/foo", "empty scope"],
    ["@scope", "scope without name"],
    ["plugin\\name", "backslash"],
  ])("rejects invalid name: %s (%s)", (name) => {
    expect(() => validatePluginName(name)).toThrow();
  });

  it("PLUGIN_NAME_PATTERN matches the validator", () => {
    expect(PLUGIN_NAME_PATTERN.test("my-plugin")).toBe(true);
    expect(PLUGIN_NAME_PATTERN.test("@scope/name")).toBe(true);
    expect(PLUGIN_NAME_PATTERN.test("not/scoped")).toBe(false);
  });
});

describe("isStability", () => {
  it("accepts the two tiers", () => {
    expect(isStability("beta")).toBe(true);
    expect(isStability("ga")).toBe(true);
  });

  it("rejects everything else (including legacy tiers)", () => {
    expect(isStability("experimental")).toBe(false);
    expect(isStability("preview")).toBe(false);
    // "stable" was the previous name for the GA tier. After the rename it
    // is no longer a valid stability value; manifests using it must
    // migrate to "ga" (or omit the field, which defaults to GA).
    expect(isStability("stable")).toBe(false);
    expect(isStability("GA")).toBe(false);
    expect(isStability("Ga")).toBe(false);
    expect(isStability("alpha")).toBe(false);
    expect(isStability(undefined)).toBe(false);
    expect(isStability(null)).toBe(false);
    expect(isStability(1)).toBe(false);
  });
});

describe("TIER_ORDER", () => {
  it("orders beta < ga", () => {
    expect(TIER_ORDER.beta).toBeLessThan(TIER_ORDER.ga);
  });

  it("IMPORT_PATH_MAP returns empty string for ga (root entrypoint)", () => {
    expect(IMPORT_PATH_MAP.ga).toBe("");
    expect(IMPORT_PATH_MAP.beta).toBe("/beta");
  });
});

describe("rewriteImportsInFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmp);
  });

  it("rewrites a single-specifier matching import", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(file, `import { x } from "@databricks/appkit/beta";\n`);
    const result = rewriteImportsInFile(file, "x", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain(`from "@databricks/appkit"`);
    expect(after).not.toContain("/beta");
  });

  it("dry-run does not write the file", () => {
    const file = path.join(tmp, "server.ts");
    const original = `import { x } from "@databricks/appkit/beta";\n`;
    fs.writeFileSync(file, original);
    const result = rewriteImportsInFile(file, "x", "/beta", "", true);
    expect(result).not.toBeNull();
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("returns null when no rewrite is needed", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(file, `import { x } from "express";\n`);
    const result = rewriteImportsInFile(file, "x", "/beta", "", false);
    expect(result).toBeNull();
  });

  it("only rewrites the targeted specifier in a multi-specifier import", () => {
    // Reviewer-flagged scenario: the old split/join would have rewritten
    // the entire `from "@databricks/appkit/beta"` source for the whole
    // line, breaking `betaB` (which doesn't exist at the stable subpath).
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(
      file,
      `import { betaA, betaB } from "@databricks/appkit/beta";\n`,
    );
    const result = rewriteImportsInFile(file, "betaA", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain(`{ betaB } from "@databricks/appkit/beta"`);
    expect(after).toContain(`{ betaA } from "@databricks/appkit"`);
  });

  it("returns null when the specifier list does not contain the plugin", () => {
    const file = path.join(tmp, "server.ts");
    const original = `import { betaA, betaB } from "@databricks/appkit/beta";\n`;
    fs.writeFileSync(file, original);
    // Promoting a different plugin — this file shouldn't change at all.
    const result = rewriteImportsInFile(file, "ghost", "/beta", "", false);
    expect(result).toBeNull();
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("preserves the `import type` keyword across the split", () => {
    const file = path.join(tmp, "types.ts");
    fs.writeFileSync(
      file,
      `import type { betaA, betaB } from "@databricks/appkit/beta";\n`,
    );
    const result = rewriteImportsInFile(file, "betaA", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain(
      `import type { betaB } from "@databricks/appkit/beta"`,
    );
    expect(after).toContain(`import type { betaA } from "@databricks/appkit"`);
  });

  it("matches an aliased specifier on the imported binding, not the alias", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(
      file,
      `import { betaA as a, betaB } from "@databricks/appkit/beta";\n`,
    );
    const result = rewriteImportsInFile(file, "betaA", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain(`{ betaB } from "@databricks/appkit/beta"`);
    expect(after).toContain(`{ betaA as a } from "@databricks/appkit"`);
  });

  it("handles multi-line specifier lists", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(
      file,
      `import {\n  betaA,\n  betaB,\n} from "@databricks/appkit/beta";\n`,
    );
    const result = rewriteImportsInFile(file, "betaA", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain(`{ betaB } from "@databricks/appkit/beta"`);
    expect(after).toContain(`{ betaA } from "@databricks/appkit"`);
  });

  it("rewrites both appkit and appkit-ui packages independently", () => {
    const file = path.join(tmp, "App.tsx");
    fs.writeFileSync(
      file,
      [
        `import { betaA, betaB } from "@databricks/appkit/beta";`,
        `import { Comp } from "@databricks/appkit-ui/react/beta";`,
        ``,
      ].join("\n"),
    );
    const result = rewriteImportsInFile(file, "betaA", "/beta", "", false);
    expect(result).not.toBeNull();
    const after = fs.readFileSync(file, "utf-8");
    // appkit: split — betaB stays beta, betaA goes stable.
    expect(after).toContain(`{ betaB } from "@databricks/appkit/beta"`);
    expect(after).toContain(`{ betaA } from "@databricks/appkit"`);
    // appkit-ui: not touched (Comp isn't the promoted plugin).
    expect(after).toContain(
      `import { Comp } from "@databricks/appkit-ui/react/beta"`,
    );
  });
});

describe("runPromote", () => {
  let h: PromoteHarness;

  beforeEach(() => {
    h = setupHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("rejects an invalid plugin name (path traversal attempt)", async () => {
    await expect(
      runPromote("../etc/passwd", { to: "ga", skipSync: true }),
    ).rejects.toThrow(/Invalid plugin name/);
  });

  it("rejects an invalid target tier", async () => {
    writeManifest(h.cwd, "my-plugin", "beta");
    await expect(
      runPromote("my-plugin", { to: "ALPHA", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /Invalid target tier/.test(e))).toBe(true);
  });

  it("rejects legacy tier names as targets", async () => {
    writeManifest(h.cwd, "my-plugin", "beta");
    // "experimental" and "preview" predate the beta/GA collapse; "stable"
    // is the previous name for the GA tier. All three must be rejected
    // up front so a stale --to flag in someone's shell history can't
    // silently no-op or land a manifest with an invalid value.
    for (const legacy of ["experimental", "preview", "stable"]) {
      h.errors.length = 0;
      await expect(
        runPromote("my-plugin", { to: legacy, skipSync: true }),
      ).rejects.toThrow(/__exit:1/);
      expect(h.errors.some((e) => /Invalid target tier/.test(e))).toBe(true);
    }
  });

  it("rejects when plugin is not found", async () => {
    await expect(
      runPromote("ghost", { to: "ga", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /not found/.test(e))).toBe(true);
  });

  it("rejects an invalid stability value in the manifest (cased 'GA')", async () => {
    writeManifest(h.cwd, "my-plugin", "GA");
    await expect(
      runPromote("my-plugin", { to: "ga", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /invalid stability value/i.test(e))).toBe(true);
  });

  it("rejects a legacy stability value in the manifest", async () => {
    // "preview" predates the beta/GA collapse; "stable" predates the
    // GA rename. Both must be rejected so a stale manifest can't reach
    // the rest of the flow with an unknown value.
    for (const legacy of ["preview", "stable"]) {
      h.errors.length = 0;
      writeManifest(h.cwd, `my-${legacy}-plugin`, legacy);
      await expect(
        runPromote(`my-${legacy}-plugin`, { to: "ga", skipSync: true }),
      ).rejects.toThrow(/__exit:1/);
      expect(h.errors.some((e) => /invalid stability value/i.test(e))).toBe(
        true,
      );
    }
  });

  it("rejects demotion from GA (absent stability) to beta", async () => {
    writeManifest(h.cwd, "my-plugin");
    await expect(
      runPromote("my-plugin", { to: "beta", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /Cannot demote/.test(e))).toBe(true);
  });

  it("rejects no-op (already at target)", async () => {
    writeManifest(h.cwd, "my-plugin", "beta");
    await expect(
      runPromote("my-plugin", { to: "beta", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /already at "beta"/.test(e))).toBe(true);
  });

  it("promotes beta to ga by removing the stability field", async () => {
    const manifestPath = writeManifest(h.cwd, "my-plugin", "beta");
    await runPromote("my-plugin", {
      to: "ga",
      skipSync: true,
      skipImports: true,
    });
    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBeUndefined();
  });

  it("dry-run does not mutate the manifest", async () => {
    const manifestPath = writeManifest(h.cwd, "my-plugin", "beta");
    const before = fs.readFileSync(manifestPath, "utf-8");
    await runPromote("my-plugin", {
      to: "ga",
      dryRun: true,
      skipSync: true,
      skipImports: true,
    });
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(before);
  });

  it("rewrites only the targeted plugin's imports across .ts and .tsx files", async () => {
    // `my-plugin` is the kebab-case manifest name; the import binding is
    // `myPlugin` (kebab-to-camelCase). The rewriter accepts both forms.
    writeManifest(h.cwd, "my-plugin", "beta");

    const tsFile = path.join(h.cwd, "server", "server.ts");
    fs.mkdirSync(path.dirname(tsFile), { recursive: true });
    fs.writeFileSync(
      tsFile,
      `import { myPlugin } from "@databricks/appkit/beta";\n`,
    );

    // Unrelated beta import — promoting `my-plugin` must NOT touch this.
    // Pre-fix, the blind `split/join` rewrite would have moved `Comp`
    // onto the stable subpath where it doesn't exist, breaking the app.
    const tsxFile = path.join(h.cwd, "client", "App.tsx");
    fs.mkdirSync(path.dirname(tsxFile), { recursive: true });
    const tsxOriginal = `import { Comp } from "@databricks/appkit-ui/react/beta";\n`;
    fs.writeFileSync(tsxFile, tsxOriginal);

    await runPromote("my-plugin", { to: "ga", skipSync: true });

    const tsAfter = fs.readFileSync(tsFile, "utf-8");
    expect(tsAfter).toContain(`{ myPlugin } from "@databricks/appkit"`);
    expect(tsAfter).not.toContain("/beta");

    expect(fs.readFileSync(tsxFile, "utf-8")).toBe(tsxOriginal);
  });

  it("skips symlinked directories during the project walk", async () => {
    writeManifest(h.cwd, "my-plugin", "beta");
    const realOutside = makeTempDir();
    try {
      const outsideTs = path.join(realOutside, "leak.ts");
      fs.writeFileSync(
        outsideTs,
        `import { x } from "@databricks/appkit/beta";\n`,
      );
      const link = path.join(h.cwd, "linked");
      try {
        fs.symlinkSync(realOutside, link, "dir");
      } catch {
        return;
      }

      await runPromote("my-plugin", { to: "ga", skipSync: true });

      expect(fs.readFileSync(outsideTs, "utf-8")).toContain(
        "@databricks/appkit/beta",
      );
    } finally {
      cleanDir(realOutside);
    }
  });

  it("refuses to mutate a node_modules-only manifest without --allow-installed", async () => {
    const manifestPath = writeManifest(
      h.cwd,
      "installed-plugin",
      "beta",
      "node_modules/@databricks/appkit/dist/plugins",
    );
    await expect(
      runPromote("installed-plugin", {
        to: "ga",
        skipSync: true,
        skipImports: true,
      }),
    ).rejects.toThrow(/__exit:1/);
    expect(
      h.errors.some((e) => /Refusing to mutate an installed package/.test(e)),
    ).toBe(true);
    const after = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(after.stability).toBe("beta");
  });

  it("rejects a path-traversal name even if a manifest exists outside node_modules/dist/plugins", async () => {
    fs.mkdirSync(
      path.join(h.cwd, "node_modules", "@databricks", "appkit", "dist"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(h.cwd, "elsewhere"), { recursive: true });
    fs.writeFileSync(
      path.join(h.cwd, "elsewhere", "manifest.json"),
      JSON.stringify({ name: "ghost", stability: "beta" }),
    );
    await expect(
      runPromote("../../../elsewhere", { to: "ga", skipSync: true }),
    ).rejects.toThrow(/Invalid plugin name/);
  });
});
