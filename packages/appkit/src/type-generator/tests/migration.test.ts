import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { _resetMigrationState, migrateProjectConfig } from "../migration";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "appkit-migration-test-"));
  _resetMigrationState();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string) {
  return fsp.writeFile(path.join(tmpDir, name), content, "utf-8");
}

function readFile(name: string) {
  return fsp.readFile(path.join(tmpDir, name), "utf-8");
}

describe("migrateProjectConfig", () => {
  // ── tsconfig.client.json ────────────────────────────────────────────

  describe("tsconfig.client.json", () => {
    test("adds shared/appkit-types to include", async () => {
      await writeFile(
        "tsconfig.client.json",
        JSON.stringify({ include: ["client/src"] }, null, 2),
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.client.json"));
      expect(result.include).toEqual(["client/src", "shared/appkit-types"]);
    });

    test("no-op if shared/appkit-types already present", async () => {
      const original = JSON.stringify(
        { include: ["client/src", "shared/appkit-types"] },
        null,
        2,
      );
      await writeFile("tsconfig.client.json", original);

      await migrateProjectConfig(tmpDir);

      const result = await readFile("tsconfig.client.json");
      expect(result).toBe(original);
    });

    test("handles JSONC block comments", async () => {
      await writeFile(
        "tsconfig.client.json",
        `{
  /* Bundler mode */
  "compilerOptions": {},
  "include": ["client/src"]
}`,
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.client.json"));
      expect(result.include).toEqual(["client/src", "shared/appkit-types"]);
    });

    test("handles JSONC line comments", async () => {
      _resetMigrationState();
      await writeFile(
        "tsconfig.client.json",
        `{
  "compilerOptions": {
    "target": "ES2022" // running on modern node
  },
  "include": ["client/src"]
}`,
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.client.json"));
      expect(result.include).toEqual(["client/src", "shared/appkit-types"]);
    });

    test("skips if include is not an array", async () => {
      const original = JSON.stringify({ compilerOptions: {} }, null, 2);
      await writeFile("tsconfig.client.json", original);

      await migrateProjectConfig(tmpDir);

      const result = await readFile("tsconfig.client.json");
      expect(result).toBe(original);
    });
  });

  // ── tsconfig.server.json ────────────────────────────────────────────

  describe("tsconfig.server.json", () => {
    test("removes emit config and adds noEmit", async () => {
      await writeFile(
        "tsconfig.server.json",
        JSON.stringify(
          {
            compilerOptions: {
              tsBuildInfoFile:
                "./node_modules/.tmp/tsconfig.server.tsbuildinfo",
              target: "ES2020",
              lib: ["ES2020"],
              outDir: "./dist",
              rootDir: "./",
              declaration: true,
              declarationMap: true,
              sourceMap: true,
            },
          },
          null,
          2,
        ),
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.server.json"));
      expect(result.compilerOptions.outDir).toBeUndefined();
      expect(result.compilerOptions.declaration).toBeUndefined();
      expect(result.compilerOptions.declarationMap).toBeUndefined();
      expect(result.compilerOptions.sourceMap).toBeUndefined();
      expect(result.compilerOptions.noEmit).toBe(true);
      expect(result.compilerOptions.rootDir).toBe("./");
      expect(result.compilerOptions.target).toBe("ES2020");
    });

    test("no-op if already using noEmit (no outDir)", async () => {
      const original = JSON.stringify(
        { compilerOptions: { noEmit: true, rootDir: "./" } },
        null,
        2,
      );
      await writeFile("tsconfig.server.json", original);

      await migrateProjectConfig(tmpDir);

      const result = await readFile("tsconfig.server.json");
      expect(result).toBe(original);
    });

    test("handles JSONC comments", async () => {
      await writeFile(
        "tsconfig.server.json",
        `{
  "compilerOptions": {
    "target": "ES2020",
    /* Emit */
    "outDir": "./dist",
    "declaration": true
  }
}`,
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.server.json"));
      expect(result.compilerOptions.outDir).toBeUndefined();
      expect(result.compilerOptions.noEmit).toBe(true);
    });

    test("preserves glob patterns in include paths", async () => {
      _resetMigrationState();
      await writeFile(
        "tsconfig.server.json",
        `{
  "extends": "./tsconfig.shared.json",
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020"],

    /* Emit */
    "outDir": "./dist",
    "rootDir": "./",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["server/**/*", "shared/**/*", "config/**/*"],
  "exclude": ["node_modules", "dist", "client"]
}`,
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("tsconfig.server.json"));
      expect(result.include).toEqual([
        "server/**/*",
        "shared/**/*",
        "config/**/*",
      ]);
      expect(result.compilerOptions.outDir).toBeUndefined();
      expect(result.compilerOptions.noEmit).toBe(true);
    });
  });

  // ── package.json ────────────────────────────────────────────────────

  describe("package.json", () => {
    test("replaces old build:server and typecheck scripts", async () => {
      await writeFile(
        "package.json",
        JSON.stringify(
          {
            name: "test-app",
            scripts: {
              "build:server": "tsdown -c tsdown.server.config.ts",
              typecheck:
                "tsc -p ./tsconfig.server.json --noEmit && tsc -p ./tsconfig.client.json --noEmit",
            },
          },
          null,
          2,
        ),
      );

      await migrateProjectConfig(tmpDir);

      const result = JSON.parse(await readFile("package.json"));
      expect(result.scripts["build:server"]).toBe(
        "tsc -b tsconfig.server.json && tsdown -c tsdown.server.config.ts",
      );
      expect(result.scripts.typecheck).toBe(
        "tsc -b tsconfig.server.json && tsc -b tsconfig.client.json",
      );
    });

    test("no-op if scripts already match new values", async () => {
      const original = JSON.stringify(
        {
          name: "test-app",
          scripts: {
            "build:server":
              "tsc -b tsconfig.server.json && tsdown -c tsdown.server.config.ts",
            typecheck:
              "tsc -b tsconfig.server.json && tsc -b tsconfig.client.json",
          },
        },
        null,
        2,
      );
      await writeFile("package.json", original);

      await migrateProjectConfig(tmpDir);

      const result = await readFile("package.json");
      expect(result).toBe(original);
    });

    test("skips custom scripts that don't match old values", async () => {
      const original = JSON.stringify(
        {
          name: "test-app",
          scripts: {
            "build:server": "my-custom-build-script",
            typecheck: "my-custom-typecheck",
          },
        },
        null,
        2,
      );
      await writeFile("package.json", original);

      await migrateProjectConfig(tmpDir);

      const result = await readFile("package.json");
      expect(result).toBe(original);
    });

    test("preserves 4-space indent", async () => {
      await writeFile(
        "package.json",
        JSON.stringify(
          {
            name: "test-app",
            scripts: {
              "build:server": "tsdown -c tsdown.server.config.ts",
            },
          },
          null,
          4,
        ),
      );

      await migrateProjectConfig(tmpDir);

      const raw = await readFile("package.json");
      // Should use 4-space indent
      expect(raw).toContain('    "name"');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  test("does not crash when no config files exist", async () => {
    await expect(migrateProjectConfig(tmpDir)).resolves.not.toThrow();
  });

  test("runs only once per project root (dedup)", async () => {
    await writeFile(
      "tsconfig.client.json",
      JSON.stringify({ include: ["client/src"] }, null, 2),
    );

    await migrateProjectConfig(tmpDir);

    // First call should have migrated
    let result = JSON.parse(await readFile("tsconfig.client.json"));
    expect(result.include).toContain("shared/appkit-types");

    // Revert the file manually
    await writeFile(
      "tsconfig.client.json",
      JSON.stringify({ include: ["client/src"] }, null, 2),
    );

    // Second call with same projectRoot should be a no-op (already migrated)
    await migrateProjectConfig(tmpDir);
    result = JSON.parse(await readFile("tsconfig.client.json"));
    expect(result.include).not.toContain("shared/appkit-types");
  });

  test("migrates different project roots independently", async () => {
    const tmpDir2 = await fsp.mkdtemp(
      path.join(os.tmpdir(), "appkit-migration-test2-"),
    );

    try {
      // Set up both projects
      await writeFile(
        "tsconfig.client.json",
        JSON.stringify({ include: ["client/src"] }, null, 2),
      );
      await fsp.writeFile(
        path.join(tmpDir2, "tsconfig.client.json"),
        JSON.stringify({ include: ["client/src"] }, null, 2),
        "utf-8",
      );

      // Migrate first project
      await migrateProjectConfig(tmpDir);

      // Second project should still migrate independently
      await migrateProjectConfig(tmpDir2);

      const result1 = JSON.parse(await readFile("tsconfig.client.json"));
      const result2 = JSON.parse(
        await fsp.readFile(path.join(tmpDir2, "tsconfig.client.json"), "utf-8"),
      );
      expect(result1.include).toContain("shared/appkit-types");
      expect(result2.include).toContain("shared/appkit-types");
    } finally {
      await fsp.rm(tmpDir2, { recursive: true, force: true });
    }
  });

  test("respects appkit.autoMigrate: false opt-out", async () => {
    await writeFile(
      "package.json",
      JSON.stringify(
        {
          name: "test-app",
          appkit: { autoMigrate: false },
          scripts: {
            "build:server": "tsdown -c tsdown.server.config.ts",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      "tsconfig.client.json",
      JSON.stringify({ include: ["client/src"] }, null, 2),
    );

    await migrateProjectConfig(tmpDir);

    // tsconfig should NOT be modified
    const tsconfig = JSON.parse(await readFile("tsconfig.client.json"));
    expect(tsconfig.include).toEqual(["client/src"]);

    // package.json scripts should NOT be modified
    const pkg = JSON.parse(await readFile("package.json"));
    expect(pkg.scripts["build:server"]).toBe(
      "tsdown -c tsdown.server.config.ts",
    );
  });
});
