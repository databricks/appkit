#!/usr/bin/env tsx
/** Validate the database starter using the SDK installed in the template artifact. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const template = await readFile(
  path.join(root, "config/database/schema.ts"),
  "utf8",
);
const block = template.match(
  /^\{\{if \.plugins\.database -\}\}\s*([\s\S]*?)\s*\{\{- end\}\}\s*$/,
);
assert(
  block,
  "The database starter must be entirely guarded by .plugins.database",
);
// Validate the selected branch of this single-block template. Keep the fixture
// inside the artifact so its imports resolve to the installed SDK, not the repo.
const fixture = await mkdtemp(path.join(root, ".database-template-check-"));
try {
  await mkdir(path.join(fixture, "config/database"), { recursive: true });
  await writeFile(
    path.join(fixture, "config/database/schema.ts"),
    block[1] + "\n",
  );
  const schema = await loadDefaultDatabaseSchema(fixture);
  assert.deepEqual(
    Object.keys(schema.$tables),
    [],
    "The starter must not expose or require sample tables",
  );
  console.log(
    "Conditional database starter loads successfully with the packaged SDK",
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
