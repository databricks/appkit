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
  it("accepts the three tiers", () => {
    expect(isStability("experimental")).toBe(true);
    expect(isStability("preview")).toBe(true);
    expect(isStability("stable")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isStability("Stable")).toBe(false);
    expect(isStability("STABLE")).toBe(false);
    expect(isStability("alpha")).toBe(false);
    expect(isStability(undefined)).toBe(false);
    expect(isStability(null)).toBe(false);
    expect(isStability(1)).toBe(false);
  });
});

describe("TIER_ORDER", () => {
  it("orders experimental < preview < stable", () => {
    expect(TIER_ORDER.experimental).toBeLessThan(TIER_ORDER.preview);
    expect(TIER_ORDER.preview).toBeLessThan(TIER_ORDER.stable);
  });

  it("IMPORT_PATH_MAP returns empty string for stable (root entrypoint)", () => {
    expect(IMPORT_PATH_MAP.stable).toBe("");
    expect(IMPORT_PATH_MAP.experimental).toBe("/experimental");
    expect(IMPORT_PATH_MAP.preview).toBe("/preview");
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

  it("rewrites a matching import", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(
      file,
      `import { x } from "@databricks/appkit/experimental";\n`,
    );
    const result = rewriteImportsInFile(
      file,
      "/experimental",
      "/preview",
      false,
    );
    expect(result).not.toBeNull();
    expect(fs.readFileSync(file, "utf-8")).toContain(
      "@databricks/appkit/preview",
    );
  });

  it("dry-run does not write the file", () => {
    const file = path.join(tmp, "server.ts");
    const original = `import { x } from "@databricks/appkit/experimental";\n`;
    fs.writeFileSync(file, original);
    const result = rewriteImportsInFile(
      file,
      "/experimental",
      "/preview",
      true,
    );
    expect(result).not.toBeNull();
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("returns null when no rewrite is needed", () => {
    const file = path.join(tmp, "server.ts");
    fs.writeFileSync(file, `import { x } from "express";\n`);
    const result = rewriteImportsInFile(
      file,
      "/experimental",
      "/preview",
      false,
    );
    expect(result).toBeNull();
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
      runPromote("../etc/passwd", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/Invalid plugin name/);
  });

  it("rejects an invalid target tier", async () => {
    writeManifest(h.cwd, "my-plugin", "experimental");
    await expect(
      runPromote("my-plugin", { to: "ALPHA", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /Invalid target tier/.test(e))).toBe(true);
  });

  it("rejects when plugin is not found", async () => {
    await expect(
      runPromote("ghost", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /not found/.test(e))).toBe(true);
  });

  it("rejects an invalid stability value in the manifest (cased 'Stable')", async () => {
    writeManifest(h.cwd, "my-plugin", "Stable");
    await expect(
      runPromote("my-plugin", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /invalid stability value/i.test(e))).toBe(true);
  });

  it("rejects demotion when manifest is at a higher valid tier", async () => {
    writeManifest(h.cwd, "my-plugin", "preview");
    await expect(
      runPromote("my-plugin", { to: "experimental", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /Cannot demote/.test(e))).toBe(true);
  });

  it("rejects demotion from stable (absent stability) to preview", async () => {
    writeManifest(h.cwd, "my-plugin");
    await expect(
      runPromote("my-plugin", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /Cannot demote/.test(e))).toBe(true);
  });

  it("rejects no-op (already at target)", async () => {
    writeManifest(h.cwd, "my-plugin", "preview");
    await expect(
      runPromote("my-plugin", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/__exit:1/);
    expect(h.errors.some((e) => /already at "preview"/.test(e))).toBe(true);
  });

  it("promotes experimental to preview and updates manifest", async () => {
    const manifestPath = writeManifest(h.cwd, "my-plugin", "experimental");
    await runPromote("my-plugin", {
      to: "preview",
      skipSync: true,
      skipImports: true,
    });
    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBe("preview");
  });

  it("promotes preview to stable by removing the stability field", async () => {
    const manifestPath = writeManifest(h.cwd, "my-plugin", "preview");
    await runPromote("my-plugin", {
      to: "stable",
      skipSync: true,
      skipImports: true,
    });
    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBeUndefined();
  });

  it("dry-run does not mutate the manifest", async () => {
    const manifestPath = writeManifest(h.cwd, "my-plugin", "experimental");
    const before = fs.readFileSync(manifestPath, "utf-8");
    await runPromote("my-plugin", {
      to: "preview",
      dryRun: true,
      skipSync: true,
      skipImports: true,
    });
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(before);
  });

  it("rewrites imports across .ts and .tsx files in the project", async () => {
    writeManifest(h.cwd, "my-plugin", "experimental");
    const tsFile = path.join(h.cwd, "server", "server.ts");
    fs.mkdirSync(path.dirname(tsFile), { recursive: true });
    fs.writeFileSync(
      tsFile,
      `import { myPlugin } from "@databricks/appkit/experimental";\n`,
    );
    const tsxFile = path.join(h.cwd, "client", "App.tsx");
    fs.mkdirSync(path.dirname(tsxFile), { recursive: true });
    fs.writeFileSync(
      tsxFile,
      `import { Comp } from "@databricks/appkit-ui/react/experimental";\n`,
    );

    await runPromote("my-plugin", { to: "preview", skipSync: true });

    expect(fs.readFileSync(tsFile, "utf-8")).toContain(
      "@databricks/appkit/preview",
    );
    expect(fs.readFileSync(tsxFile, "utf-8")).toContain(
      "@databricks/appkit-ui/react/preview",
    );
  });

  it("skips symlinked directories during the project walk", async () => {
    writeManifest(h.cwd, "my-plugin", "experimental");
    const realOutside = makeTempDir();
    try {
      const outsideTs = path.join(realOutside, "leak.ts");
      fs.writeFileSync(
        outsideTs,
        `import { x } from "@databricks/appkit/experimental";\n`,
      );
      const link = path.join(h.cwd, "linked");
      try {
        fs.symlinkSync(realOutside, link, "dir");
      } catch {
        return;
      }

      await runPromote("my-plugin", { to: "preview", skipSync: true });

      expect(fs.readFileSync(outsideTs, "utf-8")).toContain(
        "@databricks/appkit/experimental",
      );
    } finally {
      cleanDir(realOutside);
    }
  });

  it("refuses to mutate a node_modules-only manifest without --allow-installed", async () => {
    const manifestPath = writeManifest(
      h.cwd,
      "installed-plugin",
      "experimental",
      "node_modules/@databricks/appkit/dist/plugins",
    );
    await expect(
      runPromote("installed-plugin", {
        to: "preview",
        skipSync: true,
        skipImports: true,
      }),
    ).rejects.toThrow(/__exit:1/);
    expect(
      h.errors.some((e) => /Refusing to mutate an installed package/.test(e)),
    ).toBe(true);
    const after = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(after.stability).toBe("experimental");
  });

  it("rejects a path-traversal name even if a manifest exists outside node_modules/dist/plugins", async () => {
    fs.mkdirSync(
      path.join(h.cwd, "node_modules", "@databricks", "appkit", "dist"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(h.cwd, "elsewhere"), { recursive: true });
    fs.writeFileSync(
      path.join(h.cwd, "elsewhere", "manifest.json"),
      JSON.stringify({ name: "ghost", stability: "experimental" }),
    );
    await expect(
      runPromote("../../../elsewhere", { to: "preview", skipSync: true }),
    ).rejects.toThrow(/Invalid plugin name/);
  });
});
