import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defineSchema, id } from "../../../database";
import { ConfigurationError } from "../../../errors";
import { isSchema, loadSchemaByConvention, pathExists } from "../convention";

describe("database schema convention loader", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "appkit-db-schema-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function touch(relativePath: string): Promise<string> {
    const absolutePath = path.join(cwd, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export default schema;\n");
    return absolutePath;
  }

  test("returns null when no schema file exists", async () => {
    await expect(loadSchemaByConvention({ cwd })).resolves.toBeNull();
  });

  test("loads schema.ts before schema/index.ts", async () => {
    const defaultPath = await touch("config/database/schema.ts");
    await touch("config/database/schema/index.ts");

    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));
    const importer = vi.fn(async () => ({ default: schema }));

    const result = await loadSchemaByConvention({ cwd, importer });

    expect(result).toEqual({ schema, schemaPath: defaultPath });
    expect(importer).toHaveBeenCalledWith(defaultPath);
  });

  test("loads production dist schema path", async () => {
    const distPath = await touch("dist/config/database/schema.js");
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));

    const result = await loadSchemaByConvention({
      cwd,
      importer: vi.fn(async () => ({ default: schema })),
    });

    expect(result?.schemaPath).toBe(distPath);
    expect(result?.schema).toBe(schema);
  });

  test("unwraps nested default exports from TS loaders", async () => {
    const schemaPath = await touch("config/database/schema.ts");
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));

    const result = await loadSchemaByConvention({
      cwd,
      importer: vi.fn(async () => ({ default: { default: schema } })),
    });

    expect(result).toEqual({ schema, schemaPath });
  });

  test("unwraps three levels of `default` (cjs interop in cjs interop)", async () => {
    const schemaPath = await touch("config/database/schema.ts");
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));

    const result = await loadSchemaByConvention({
      cwd,
      importer: vi.fn(async () => ({
        default: { default: { default: schema } },
      })),
    });

    expect(result).toEqual({ schema, schemaPath });
  });

  test("rejects schemas wrapped beyond the safety limit (4+ levels)", async () => {
    await touch("config/database/schema.ts");
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));

    await expect(
      loadSchemaByConvention({
        cwd,
        importer: vi.fn(async () => ({
          default: { default: { default: { default: schema } } },
        })),
      }),
    ).rejects.toThrow(/defineSchema/);
  });

  test("throws a configuration error for invalid schema modules", async () => {
    await touch("config/database/schema.ts");

    await expect(
      loadSchemaByConvention({
        cwd,
        importer: vi.fn(async () => ({ default: { nope: true } })),
      }),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      loadSchemaByConvention({
        cwd,
        importer: vi.fn(async () => ({ default: { nope: true } })),
      }),
    ).rejects.toThrow(/defineSchema/);
  });

  test("recognizes AppKit schema objects", async () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));

    expect(isSchema(schema)).toBe(true);
    expect(isSchema({ $tables: {} })).toBe(false);
    expect(await pathExists(path.join(cwd, "missing.ts"))).toBe(false);
  });
});
