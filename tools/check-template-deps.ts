#!/usr/bin/env tsx
/**
 * Validates that all dependencies in template/package.json use exact versions
 * (no ^, ~, >=, * prefixes) AND that a small allowlist of version-sensitive
 * runtime deps matches the version AppKit was built against.
 *
 * The pin check is the supply-chain guard: template sync writes through to
 * scaffolded apps verbatim, so a `^4.x` here would let npm install resolve to
 * a different minor than CI tested and let a malicious patch slip in.
 *
 * The cross-version check is a type-safety guard. AppKit's public surface
 * exposes `zod`-typed APIs (`tool({ schema: z.object(...) })`, etc.).
 * Zod ships ZodType structural changes between minors — methods added in
 * 4.3 (`toJSONSchema`, `with`, `exactOptional`, `apply`) aren't on 4.1's
 * ZodType — so a template pinned a few patches behind AppKit hands scaffolded
 * users a tsc error on every `tool()` callsite even though AppKit itself
 * type-checks fine internally. Failing CI here keeps the bump in one place.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const templatePkg = JSON.parse(
  readFileSync(join(ROOT, "template/package.json"), "utf-8"),
);
const appkitPkg = JSON.parse(
  readFileSync(join(ROOT, "packages/appkit/package.json"), "utf-8"),
);

const templateDeps: Record<string, string> = {
  ...templatePkg.dependencies,
  ...templatePkg.devDependencies,
};
const appkitDeps: Record<string, string> = {
  ...appkitPkg.dependencies,
  ...appkitPkg.devDependencies,
};

const errors: string[] = [];

// Pin check.
const PINNED_VERSION = /^(npm:(@[\w-]+\/)?[\w.-]+@)?\d+\.\d+\.\d+(-[\w.]+)?$/;
const unpinned = Object.entries(templateDeps).filter(
  ([, v]) => !PINNED_VERSION.test(v),
);
if (unpinned.length) {
  errors.push(
    `Unpinned template deps: ${unpinned.map(([k, v]) => `${k}@${v}`).join(", ")}`,
  );
}

// Cross-version check against AppKit. Limited to deps whose types leak
// through AppKit's public API surface — bumping any of these in AppKit
// without bumping the template here produces a confusing tsc error in
// scaffolded apps (e.g. "ZodObject is missing 'toJSONSchema' from ZodType").
const SYNCED_DEPS = ["zod"];
for (const dep of SYNCED_DEPS) {
  const templateVer = templateDeps[dep];
  const appkitVer = appkitDeps[dep];
  if (templateVer && appkitVer && templateVer !== appkitVer) {
    errors.push(
      `Version skew on ${dep}: template pins ${templateVer}, ` +
        `packages/appkit pins ${appkitVer}. Update template/package.json ` +
        `so types resolved through @databricks/appkit match the version ` +
        `installed in scaffolded apps.`,
    );
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
