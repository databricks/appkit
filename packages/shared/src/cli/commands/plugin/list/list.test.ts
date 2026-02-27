import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listFromDirectory,
  listFromManifestFile,
  type PluginRow,
} from "./list";

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

const TEMPLATE_MANIFEST_JSON = {
  $schema:
    "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
  version: "1.0",
  plugins: {
    server: {
      name: "server",
      displayName: "Server Plugin",
      package: "@databricks/appkit",
      resources: { required: [], optional: [] },
    },
    analytics: {
      name: "analytics",
      displayName: "Analytics Plugin",
      package: "@databricks/appkit",
      resources: {
        required: [{ type: "sql_warehouse" }],
        optional: [],
      },
    },
  },
};

const PLUGIN_MANIFEST_JSON = {
  $schema:
    "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
  name: "my-feature",
  displayName: "My Feature",
  description: "A test plugin",
  resources: { required: [], optional: [] },
};

describe("list", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanDir(dir);
    tempDirs.length = 0;
  });

  describe("listFromManifestFile", () => {
    it("returns plugin rows from a template manifest file", () => {
      const tmp = makeTempDir("list-manifest");
      tempDirs.push(tmp);
      const manifestPath = path.join(tmp, "appkit.plugins.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(TEMPLATE_MANIFEST_JSON, null, 2),
      );

      const rows = listFromManifestFile(manifestPath);

      expect(rows).toHaveLength(2);
      const byName = (r: PluginRow) => r.name;
      expect(rows.map(byName).sort()).toEqual(["analytics", "server"]);
      const server = rows.find((r) => r.name === "server");
      expect(server?.displayName).toBe("Server Plugin");
      expect(server?.package).toBe("@databricks/appkit");
      expect(server?.required).toBe(0);
      expect(server?.optional).toBe(0);
      const analytics = rows.find((r) => r.name === "analytics");
      expect(analytics?.required).toBe(1);
      expect(analytics?.optional).toBe(0);
    });

    it("returns empty array when plugins object is empty", () => {
      const tmp = makeTempDir("list-manifest-empty");
      tempDirs.push(tmp);
      const manifestPath = path.join(tmp, "appkit.plugins.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          $schema:
            "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
          version: "1.0",
          plugins: {},
        }),
      );

      const rows = listFromManifestFile(manifestPath);
      expect(rows).toEqual([]);
    });

    it("throws when file does not exist", () => {
      expect(() =>
        listFromManifestFile("/nonexistent/appkit.plugins.json"),
      ).toThrow(/Failed to read manifest file/);
    });

    it("throws when file is invalid JSON", () => {
      const tmp = makeTempDir("list-manifest-bad");
      tempDirs.push(tmp);
      const manifestPath = path.join(tmp, "bad.json");
      fs.writeFileSync(manifestPath, "not json {");

      expect(() => listFromManifestFile(manifestPath)).toThrow(
        /Failed to parse manifest file/,
      );
    });
  });

  describe("listFromDirectory", () => {
    it("returns plugin rows from subdirectories with manifest.json", async () => {
      const tmp = makeTempDir("list-dir");
      tempDirs.push(tmp);
      const pluginDir = path.join(tmp, "my-feature");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "manifest.json"),
        JSON.stringify(PLUGIN_MANIFEST_JSON, null, 2),
      );

      const rows = await listFromDirectory(tmp, path.dirname(tmp));

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("my-feature");
      expect(rows[0].displayName).toBe("My Feature");
      expect(rows[0].package).toContain("my-feature");
      expect(rows[0].required).toBe(0);
      expect(rows[0].optional).toBe(0);
    });

    it("returns empty array when directory does not exist", async () => {
      const rows = await listFromDirectory("/nonexistent/dir", "/");
      expect(rows).toEqual([]);
    });

    it("returns empty array when directory has no plugin subdirs with manifest", async () => {
      const tmp = makeTempDir("list-dir-empty");
      tempDirs.push(tmp);
      fs.mkdirSync(path.join(tmp, "empty-subdir"), { recursive: true });

      const rows = await listFromDirectory(tmp, path.dirname(tmp));
      expect(rows).toEqual([]);
    });

    it("skips subdirs without manifest.json", async () => {
      const tmp = makeTempDir("list-dir-skip");
      tempDirs.push(tmp);
      const withManifest = path.join(tmp, "with-manifest");
      fs.mkdirSync(withManifest, { recursive: true });
      fs.writeFileSync(
        path.join(withManifest, "manifest.json"),
        JSON.stringify(PLUGIN_MANIFEST_JSON, null, 2),
      );
      fs.mkdirSync(path.join(tmp, "no-manifest"), { recursive: true });

      const rows = await listFromDirectory(tmp, path.dirname(tmp));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("my-feature");
    });

    it("does not load JS-only manifests by default", async () => {
      const tmp = makeTempDir("list-dir-js-disabled");
      tempDirs.push(tmp);
      const jsOnlyDir = path.join(tmp, "js-only");
      fs.mkdirSync(jsOnlyDir, { recursive: true });
      fs.writeFileSync(
        path.join(jsOnlyDir, "manifest.js"),
        `export default ${JSON.stringify(PLUGIN_MANIFEST_JSON)}`,
      );

      const rows = await listFromDirectory(tmp, path.dirname(tmp));
      expect(rows).toEqual([]);
    });

    it("loads JS-only manifests when explicitly enabled", async () => {
      const tmp = makeTempDir("list-dir-js-enabled");
      tempDirs.push(tmp);
      const jsOnlyDir = path.join(tmp, "js-only");
      fs.mkdirSync(jsOnlyDir, { recursive: true });
      fs.writeFileSync(
        path.join(jsOnlyDir, "manifest.js"),
        `export default ${JSON.stringify(PLUGIN_MANIFEST_JSON)}`,
      );

      const rows = await listFromDirectory(tmp, path.dirname(tmp), true);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("my-feature");
    });

    it("loads JS manifests from trusted node_modules packages by default", async () => {
      const tmp = makeTempDir("list-dir-trusted-node-modules");
      tempDirs.push(tmp);
      const pluginDir = path.join(
        tmp,
        "node_modules",
        "@databricks",
        "appkit",
        "my-feature",
      );
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "manifest.js"),
        `export default ${JSON.stringify(PLUGIN_MANIFEST_JSON)}`,
      );

      const rows = await listFromDirectory(tmp, tmp);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("my-feature");
    });

    it("does not load JS manifests from untrusted node_modules packages by default", async () => {
      const tmp = makeTempDir("list-dir-untrusted-node-modules");
      tempDirs.push(tmp);
      const pluginDir = path.join(
        tmp,
        "node_modules",
        "@acme",
        "plugin",
        "my-feature",
      );
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "manifest.js"),
        `export default ${JSON.stringify(PLUGIN_MANIFEST_JSON)}`,
      );

      const rows = await listFromDirectory(tmp, tmp);
      expect(rows).toEqual([]);
    });
  });
});
