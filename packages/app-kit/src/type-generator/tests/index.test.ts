import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateFromEntryPoint } from "../index";

const outputDir = path.join(__dirname, "__output__");

describe("generateFromEntryPoint", () => {
  beforeAll(() => {
    // Create output directory once before all tests
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up output directory after all tests complete
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true });
    }
  });

  // Note: Query schema generation now requires Databricks connection
  // This test verifies the basic structure without actual query execution
  test("generates type declarations without query folder", async () => {
    const outFile = path.join(outputDir, "types-with-queries.d.ts");

    await generateFromEntryPoint({
      outFile,
      warehouseId: "test",
    });

    expect(fs.existsSync(outFile)).toBe(true);

    const content = fs.readFileSync(outFile, "utf-8");

    // Check QueryRegistry is included (empty when no queryFolder)
    expect(content).toContain("interface QueryRegistry");
  });

  test("generates empty QueryRegistry when no query folder provided", async () => {
    const outFile = path.join(outputDir, "types-no-queries.d.ts");

    await generateFromEntryPoint({
      outFile,
      warehouseId: "test",
    });

    const content = fs.readFileSync(outFile, "utf-8");

    // QueryRegistry should be empty
    expect(content).toContain("interface QueryRegistry {}");
  });
});
