import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetDir, scaffoldPlugin } from "./scaffold";
import type { CreateAnswers } from "./types";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const BASE_ANSWERS: CreateAnswers = {
  placement: "in-repo",
  targetPath: "test-plugin",
  name: "my-plugin",
  displayName: "My Plugin",
  description: "A test plugin",
  resources: [],
  version: "0.1.0",
};

describe("scaffold", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanDir(dir);
    tempDirs.length = 0;
  });

  describe("resolveTargetDir", () => {
    it("resolves relative path against cwd", () => {
      const result = resolveTargetDir("/home/user/project", {
        ...BASE_ANSWERS,
        targetPath: "plugins/my-plugin",
      });
      expect(result).toBe(
        path.resolve("/home/user/project", "plugins/my-plugin"),
      );
    });

    it("resolves absolute path as-is", () => {
      const result = resolveTargetDir("/home/user/project", {
        ...BASE_ANSWERS,
        targetPath: "/tmp/my-plugin",
      });
      expect(result).toBe("/tmp/my-plugin");
    });
  });

  describe("scaffoldPlugin (in-repo)", () => {
    it("creates core files: manifest.json, manifest.ts, plugin.ts, index.ts", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "my-plugin");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: false });

      expect(fs.existsSync(path.join(targetDir, "manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "manifest.ts"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "my-plugin.ts"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "package.json"))).toBe(false);
    });

    it("generates valid manifest.json with correct fields", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: false });

      const manifest = JSON.parse(
        fs.readFileSync(path.join(targetDir, "manifest.json"), "utf-8"),
      );
      expect(manifest.name).toBe("my-plugin");
      expect(manifest.displayName).toBe("My Plugin");
      expect(manifest.description).toBe("A test plugin");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.resources).toEqual({ required: [], optional: [] });
      expect(manifest.$schema).toContain("plugin-manifest.schema.json");
    });

    it("generates plugin class with PascalCase name", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: false });

      const pluginTs = fs.readFileSync(
        path.join(targetDir, "my-plugin.ts"),
        "utf-8",
      );
      expect(pluginTs).toContain("class MyPlugin");
      expect(pluginTs).toContain("export const myPlugin = toPlugin");
    });

    it("generates index.ts with correct exports", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: false });

      const indexTs = fs.readFileSync(
        path.join(targetDir, "index.ts"),
        "utf-8",
      );
      expect(indexTs).toContain("MyPlugin");
      expect(indexTs).toContain("myPlugin");
    });

    it("includes resources in manifest when provided", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      const answers: CreateAnswers = {
        ...BASE_ANSWERS,
        resources: [
          {
            type: "sql_warehouse",
            required: true,
            description: "Needed for queries",
            resourceKey: "sql-warehouse",
            permission: "CAN_USE",
            fields: {
              id: {
                env: "DATABRICKS_WAREHOUSE_ID",
                description: "SQL Warehouse ID",
              },
            },
          },
          {
            type: "secret",
            required: false,
            description: "Optional creds",
            resourceKey: "secret",
            permission: "READ",
            fields: {
              scope: { env: "SECRET_SCOPE", description: "Secret scope name" },
              key: { env: "SECRET_KEY", description: "Secret key" },
            },
          },
        ],
      };

      scaffoldPlugin(targetDir, answers, { isolated: false });

      const manifest = JSON.parse(
        fs.readFileSync(path.join(targetDir, "manifest.json"), "utf-8"),
      );
      expect(manifest.resources.required).toHaveLength(1);
      expect(manifest.resources.optional).toHaveLength(1);
      expect(manifest.resources.required[0].type).toBe("sql_warehouse");
      expect(manifest.resources.required[0].resourceKey).toBe("sql-warehouse");
      expect(manifest.resources.required[0].permission).toBe("CAN_USE");
      expect(manifest.resources.optional[0].type).toBe("secret");
      expect(manifest.resources.optional[0].resourceKey).toBe("secret");
    });

    it("includes optional author, version, license", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      const answers: CreateAnswers = {
        ...BASE_ANSWERS,
        author: "Test Author",
        version: "2.0.0",
        license: "MIT",
      };

      scaffoldPlugin(targetDir, answers, { isolated: false });

      const manifest = JSON.parse(
        fs.readFileSync(path.join(targetDir, "manifest.json"), "utf-8"),
      );
      expect(manifest.author).toBe("Test Author");
      expect(manifest.version).toBe("2.0.0");
      expect(manifest.license).toBe("MIT");
    });
  });

  describe("scaffoldPlugin (isolated)", () => {
    it("creates package.json, tsconfig.json, and README.md in addition to core files", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "my-plugin");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: true });

      expect(fs.existsSync(path.join(targetDir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "tsconfig.json"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "README.md"))).toBe(true);
    });

    it("generates package.json with correct name prefix", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "test");

      scaffoldPlugin(targetDir, BASE_ANSWERS, { isolated: true });

      const pkg = JSON.parse(
        fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"),
      );
      expect(pkg.name).toBe("appkit-plugin-my-plugin");
      expect(pkg.version).toBe("0.1.0");
      expect(pkg.type).toBe("module");
      expect(pkg.peerDependencies["@databricks/appkit"]).toBeDefined();
    });
  });

  describe("rollback on failure", () => {
    it("cleans up written files when a write fails partway through", () => {
      const tmp = makeTempDir();
      tempDirs.push(tmp);
      const targetDir = path.join(tmp, "failing-plugin");

      const badAnswers: CreateAnswers = {
        ...BASE_ANSWERS,
        name: "test-fail",
      };

      fs.mkdirSync(targetDir, { recursive: true });
      const blockingDir = path.join(targetDir, "index.ts");
      fs.mkdirSync(blockingDir);

      expect(() =>
        scaffoldPlugin(targetDir, badAnswers, { isolated: false }),
      ).toThrow();

      expect(fs.existsSync(path.join(targetDir, "manifest.json"))).toBe(false);
      expect(fs.existsSync(path.join(targetDir, "manifest.ts"))).toBe(false);
    });
  });
});
