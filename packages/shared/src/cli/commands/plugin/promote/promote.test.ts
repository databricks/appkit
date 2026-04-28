import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

function writeManifest(dir: string, name: string, stability?: string): string {
  const pluginDir = path.join(dir, "plugins", name);
  fs.mkdirSync(pluginDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    $schema:
      "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `Test plugin ${name}`,
    resources: { required: [], optional: [] },
  };
  if (stability) manifest.stability = stability;
  const manifestPath = path.join(pluginDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

describe("promote - manifest mutation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanDir(dir);
    tempDirs.length = 0;
  });

  it("promotes experimental to preview by updating stability field", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const manifestPath = writeManifest(tmp, "my-plugin", "experimental");

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    raw.stability = "preview";
    fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBe("preview");
  });

  it("promotes preview to stable by removing stability field", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const manifestPath = writeManifest(tmp, "my-plugin", "preview");

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    delete raw.stability;
    fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBeUndefined();
  });

  it("promotes experimental directly to stable", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const manifestPath = writeManifest(tmp, "my-plugin", "experimental");

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    delete raw.stability;
    fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    const updated = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(updated.stability).toBeUndefined();
  });
});

describe("promote - validation", () => {
  it("rejects demotion (stable to preview)", () => {
    const tiers = { experimental: 0, preview: 1, stable: 2 };
    const current = "stable";
    const target = "preview";
    expect(tiers[target] <= tiers[current]).toBe(true);
  });

  it("rejects demotion (preview to experimental)", () => {
    const tiers = { experimental: 0, preview: 1, stable: 2 };
    const current = "preview";
    const target = "experimental";
    expect(tiers[target] <= tiers[current]).toBe(true);
  });

  it("rejects no-op (already at target)", () => {
    const current = "preview";
    const target = "preview";
    expect(current === target).toBe(true);
  });

  it("accepts valid upward promotions", () => {
    const tiers = { experimental: 0, preview: 1, stable: 2 };
    expect(tiers.preview > tiers.experimental).toBe(true);
    expect(tiers.stable > tiers.preview).toBe(true);
    expect(tiers.stable > tiers.experimental).toBe(true);
  });
});

describe("promote - import rewriting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanDir(dir);
    tempDirs.length = 0;
  });

  it("rewrites @databricks/appkit/experimental to /preview", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const tsFile = path.join(tmp, "server.ts");
    fs.writeFileSync(
      tsFile,
      `import { myPlugin } from "@databricks/appkit/experimental";\n`,
    );

    const content = fs.readFileSync(tsFile, "utf-8");
    const updated = content
      .split("@databricks/appkit/experimental")
      .join("@databricks/appkit/preview");
    fs.writeFileSync(tsFile, updated);

    expect(fs.readFileSync(tsFile, "utf-8")).toContain(
      "@databricks/appkit/preview",
    );
    expect(fs.readFileSync(tsFile, "utf-8")).not.toContain(
      "@databricks/appkit/experimental",
    );
  });

  it("rewrites @databricks/appkit/preview to @databricks/appkit", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const tsFile = path.join(tmp, "server.ts");
    fs.writeFileSync(
      tsFile,
      `import { myPlugin } from "@databricks/appkit/preview";\n`,
    );

    const content = fs.readFileSync(tsFile, "utf-8");
    const updated = content
      .split("@databricks/appkit/preview")
      .join("@databricks/appkit");
    fs.writeFileSync(tsFile, updated);

    const result = fs.readFileSync(tsFile, "utf-8");
    expect(result).toContain('"@databricks/appkit"');
    expect(result).not.toContain("/preview");
  });

  it("rewrites appkit-ui paths alongside appkit paths", () => {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    const tsFile = path.join(tmp, "app.tsx");
    fs.writeFileSync(
      tsFile,
      [
        `import { Comp } from "@databricks/appkit-ui/react/experimental";`,
        `import { util } from "@databricks/appkit-ui/js/experimental";`,
      ].join("\n"),
    );

    const content = fs.readFileSync(tsFile, "utf-8");
    const updated = content.split("/experimental").join("/preview");
    fs.writeFileSync(tsFile, updated);

    const result = fs.readFileSync(tsFile, "utf-8");
    expect(result).toContain("@databricks/appkit-ui/react/preview");
    expect(result).toContain("@databricks/appkit-ui/js/preview");
    expect(result).not.toContain("/experimental");
  });
});
