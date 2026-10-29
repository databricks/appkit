#!/usr/bin/env tsx

/**
 * Writes the props schema of every `data-appkit` draft component to
 * packages/appkit-ui/src/design/components.schema.json, shipped as
 * `@databricks/appkit-ui/design/components.schema.json` so an agent can read
 * it from node_modules. The design plugin's tests fail when it's stale.
 *
 * Usage: pnpm exec tsx tools/generate-design-schema.ts
 */

import fs from "node:fs";
import path from "node:path";

import { dataAppkitSchema } from "../packages/appkit/src/plugins/design/drafts";

const out = path.join(
  import.meta.dirname,
  "../packages/appkit-ui/src/design/components.schema.json",
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(dataAppkitSchema(), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
