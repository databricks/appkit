import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { isWithinDirectory, parseImports, parsePluginUsages } from "./sync";

describe("plugin sync", () => {
  describe("isWithinDirectory", () => {
    it("returns true when filePath equals boundary", () => {
      const dir = path.resolve("/project/root");
      expect(isWithinDirectory(dir, dir)).toBe(true);
    });

    it("returns true when filePath is inside boundary", () => {
      expect(
        isWithinDirectory("/project/root/sub/file.ts", "/project/root"),
      ).toBe(true);
      expect(isWithinDirectory("/project/root/foo", "/project/root")).toBe(
        true,
      );
    });

    it("returns false when filePath escapes boundary", () => {
      expect(
        isWithinDirectory("/project/root/../etc/passwd", "/project/root"),
      ).toBe(false);
      expect(isWithinDirectory("/other/file.ts", "/project/root")).toBe(false);
    });

    it("returns false when path is sibling (prefix edge case)", () => {
      const root = path.resolve("/project/root");
      const sibling = path.resolve("/project/root-bar/file.ts");
      expect(isWithinDirectory(sibling, root)).toBe(false);
    });

    it("handles relative paths by resolving them", () => {
      const cwd = process.cwd();
      expect(isWithinDirectory("package.json", cwd)).toBe(true);
    });
  });

  describe("parseImports", () => {
    function parseCode(code: string) {
      const ast = parse(Lang.TypeScript, code);
      return parseImports(ast.root());
    }

    it("extracts named imports from a single statement", () => {
      const imports = parseCode(
        `import { createApp, server, analytics } from "@databricks/appkit";`,
      );
      expect(imports).toHaveLength(3);
      expect(imports.map((i) => i.name)).toEqual([
        "createApp",
        "server",
        "analytics",
      ]);
      expect(imports.map((i) => i.originalName)).toEqual([
        "createApp",
        "server",
        "analytics",
      ]);
      expect(imports[0].source).toBe("@databricks/appkit");
    });

    it("extracts aliased imports", () => {
      const imports = parseCode(
        `import { createApp as initApp, server as srv } from "@databricks/appkit";`,
      );
      expect(imports).toHaveLength(2);
      expect(imports[0]).toEqual({
        name: "initApp",
        originalName: "createApp",
        source: "@databricks/appkit",
      });
      expect(imports[1]).toEqual({
        name: "srv",
        originalName: "server",
        source: "@databricks/appkit",
      });
    });

    it("extracts relative imports", () => {
      const imports = parseCode(
        `import { myPlugin } from "./plugins/my-plugin";`,
      );
      expect(imports).toHaveLength(1);
      expect(imports[0].name).toBe("myPlugin");
      expect(imports[0].source).toBe("./plugins/my-plugin");
    });

    it("handles double-quoted specifiers", () => {
      const imports = parseCode(`import { foo } from "@databricks/appkit";`);
      expect(imports[0].source).toBe("@databricks/appkit");
    });

    it("returns empty array when no named imports", () => {
      const imports = parseCode(`const x = 1;`);
      expect(imports).toHaveLength(0);
    });

    it("handles multiple import statements", () => {
      const imports = parseCode(`
        import { createApp } from "@databricks/appkit";
        import { myPlugin } from "./my-plugin";
      `);
      expect(imports).toHaveLength(2);
      expect(imports[0].source).toBe("@databricks/appkit");
      expect(imports[1].source).toBe("./my-plugin");
    });
  });

  describe("parsePluginUsages", () => {
    function parseCode(code: string) {
      const ast = parse(Lang.TypeScript, code);
      return parsePluginUsages(ast.root());
    }

    it("extracts plugin names used in createApp plugins array", () => {
      const used = parseCode(`
        createApp({
          plugins: [
            server(),
            analytics(),
          ],
        });
      `);
      expect(Array.from(used)).toEqual(
        expect.arrayContaining(["server", "analytics"]),
      );
      expect(used.size).toBe(2);
    });

    it("ignores non-plugin call expressions in the same object", () => {
      const used = parseCode(`
        createApp({
          plugins: [server()],
          telemetry: { enabled: true },
        });
      `);
      expect(Array.from(used)).toEqual(["server"]);
    });

    it("returns empty set when no plugins key with array", () => {
      const used = parseCode(`createApp({});`);
      expect(used.size).toBe(0);
    });

    it("returns empty set when plugins is not an array of calls", () => {
      const used = parseCode(`
        createApp({
          plugins: [],
        });
      `);
      expect(used.size).toBe(0);
    });

    it("extracts single plugin usage", () => {
      const used = parseCode(`
        createApp({
          plugins: [server()],
        });
      `);
      expect(Array.from(used)).toEqual(["server"]);
    });
  });
});
