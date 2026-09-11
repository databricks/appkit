#!/usr/bin/env tsx
/** Validate the database starter using the SDK installed in the template artifact. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? "pr-template");
const require = createRequire(path.join(root, "package.json"));
const sdkRoot = path.dirname(
  require.resolve("@databricks/appkit/package.json"),
);
// This is a package integration check, so use the artifact's actual runtime loader.
const { loadDefaultDatabaseSchema } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/plugins/database/load-schema.js")).href
);
const schema = await loadDefaultDatabaseSchema(root);
assert.deepEqual(
  Object.keys(schema.$tables),
  [],
  "The starter must not expose or require sample tables",
);
console.log(
  "Database template starter loads successfully with the packaged SDK",
);
