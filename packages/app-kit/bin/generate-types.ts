#!/usr/bin/env tsx
import path from "node:path";

import { generateFromEntryPoint } from "../src/type-generator";

// Parse arguments
const args = process.argv.slice(2);
const noCache = args.includes("--no-cache");
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

const rootDir = positionalArgs[0] || process.cwd();
const outFile =
  positionalArgs[1] || path.join(process.cwd(), "client/src/appKitTypes.d.ts");

const queryFolder = path.join(rootDir, "config/queries");

const warehouseId = positionalArgs[2] || process.env.DATABRICKS_WAREHOUSE_ID;
if (!warehouseId) {
  throw new Error("DATABRICKS_WAREHOUSE_ID is not set");
}

await generateFromEntryPoint({
  queryFolder,
  outFile,
  warehouseId,
  noCache,
});
