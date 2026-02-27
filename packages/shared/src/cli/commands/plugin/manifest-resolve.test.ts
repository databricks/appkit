import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestFromFile, resolveManifestInDir } from "./manifest-resolve";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const SAMPLE_MANIFEST = {
  name: "test-plugin",
  displayName: "Test Plugin",
  description: "A test",
  resources: { required: [], optional: [] },
};

describe("manifest-resolve", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanDir(dir);
    tempDirs.length = 0;
  });

  describe("resolveManifestInDir", () => {
    it("returns manifest.json when present", () => {
      const dir = makeTempDir("resolve-json");
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify(SAMPLE_MANIFEST),
      );

      const result = resolveManifestInDir(dir);
      expect(result).not.toBeNull();
      expect(result?.path).toContain("manifest.json");
      expect(result?.type).toBe("json");
    });

    it("prefers manifest.json over manifest.js even when JS is allowed", () => {
      const dir = makeTempDir("resolve-order");
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify(SAMPLE_MANIFEST),
      );
      fs.writeFileSync(
        path.join(dir, "manifest.js"),
        `export default ${JSON.stringify(SAMPLE_MANIFEST)}`,
      );

      const result = resolveManifestInDir(dir, { allowJsManifest: true });
      expect(result?.path).toContain("manifest.json");
      expect(result?.type).toBe("json");
    });

    it("returns null for JS-only plugin when JS manifests are disabled", () => {
      const dir = makeTempDir("resolve-js");
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "manifest.js"),
        `export default ${JSON.stringify(SAMPLE_MANIFEST)}`,
      );

      const result = resolveManifestInDir(dir);
      expect(result).toBeNull();
    });

    it("returns manifest.js when manifest.json is absent and JS is allowed", () => {
      const dir = makeTempDir("resolve-js-allowed");
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "manifest.js"),
        `export default ${JSON.stringify(SAMPLE_MANIFEST)}`,
      );

      const result = resolveManifestInDir(dir, { allowJsManifest: true });
      expect(result).not.toBeNull();
      expect(result?.path).toContain("manifest.js");
      expect(result?.type).toBe("js");
    });

    it("returns null when no manifest file exists", () => {
      const dir = makeTempDir("resolve-none");
      tempDirs.push(dir);

      const result = resolveManifestInDir(dir);
      expect(result).toBeNull();
    });
  });

  describe("loadManifestFromFile", () => {
    it("loads JSON manifest", async () => {
      const dir = makeTempDir("load-json");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(SAMPLE_MANIFEST));

      const loaded = await loadManifestFromFile(manifestPath, "json");
      expect(loaded).toEqual(SAMPLE_MANIFEST);
    });

    it("returns object for JSON path when type is json", async () => {
      const dir = makeTempDir("load-json-path");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "custom.json");
      fs.writeFileSync(manifestPath, JSON.stringify(SAMPLE_MANIFEST));

      const loaded = await loadManifestFromFile(manifestPath, "json");
      expect(loaded).toEqual(SAMPLE_MANIFEST);
    });

    it("throws for JS manifest when JS loading is disabled", async () => {
      const dir = makeTempDir("load-js-disabled");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.js");
      fs.writeFileSync(
        manifestPath,
        `export default ${JSON.stringify(SAMPLE_MANIFEST)};`,
      );

      await expect(loadManifestFromFile(manifestPath, "js")).rejects.toThrow(
        /Refusing to execute JS manifest/,
      );
    });

    it("loads ESM manifest.js via dynamic import when JS is allowed", async () => {
      const dir = makeTempDir("load-esm");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.js");
      fs.writeFileSync(
        manifestPath,
        `export default ${JSON.stringify(SAMPLE_MANIFEST)};`,
      );

      const loaded = await loadManifestFromFile(manifestPath, "js", {
        allowJsManifest: true,
      });
      expect(loaded).toEqual(SAMPLE_MANIFEST);
    });

    it("loads CJS manifest.cjs via require when JS is allowed", async () => {
      const dir = makeTempDir("load-cjs");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.cjs");
      fs.writeFileSync(
        manifestPath,
        `module.exports = ${JSON.stringify(SAMPLE_MANIFEST)};`,
      );

      const loaded = await loadManifestFromFile(manifestPath, "js", {
        allowJsManifest: true,
      });
      expect(loaded).toEqual(SAMPLE_MANIFEST);
    });

    it("loads CJS manifest.cjs that uses module.exports.default when JS is allowed", async () => {
      const dir = makeTempDir("load-cjs-default");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.cjs");
      fs.writeFileSync(
        manifestPath,
        `module.exports.default = ${JSON.stringify(SAMPLE_MANIFEST)};`,
      );

      const loaded = await loadManifestFromFile(manifestPath, "js", {
        allowJsManifest: true,
      });
      expect(loaded).toEqual(SAMPLE_MANIFEST);
    });

    it("throws on malformed JSON", async () => {
      const dir = makeTempDir("load-bad-json");
      tempDirs.push(dir);
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, "{ not valid json }");

      await expect(
        loadManifestFromFile(manifestPath, "json"),
      ).rejects.toThrow();
    });
  });
});
