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

import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");

const templatePkg = JSON.parse(
  readFileSync(join(ROOT, "template/package.json"), "utf-8"),
);
const appkitPkg = JSON.parse(
  readFileSync(join(ROOT, "packages/appkit/package.json"), "utf-8"),
);

// Parse pnpm-workspace.yaml using YAML parser.
const templatePnpmWorkspaceYaml = parseYaml(
  readFileSync(join(ROOT, "template/pnpm-workspace.yaml"), "utf-8"),
) as Record<string, unknown>;

const templatePnpmWorkspace = {
  overrides: (templatePnpmWorkspaceYaml.overrides ?? {}) as Record<
    string,
    unknown
  >,
};

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

// Overrides parity check: npm and pnpm must agree on override versions.
const npmOverrides = templatePkg.overrides ?? {};
const pnpmOverrides =
  (templatePnpmWorkspace.overrides as Record<string, unknown>) ?? {};
const allOverrideKeys = new Set([
  ...Object.keys(npmOverrides),
  ...Object.keys(pnpmOverrides),
]);
for (const key of allOverrideKeys) {
  const npmVal = npmOverrides[key];
  const pnpmVal = pnpmOverrides[key];
  if (npmVal !== pnpmVal) {
    errors.push(
      `Overrides mismatch for "${key}": template/package.json has ${JSON.stringify(npmVal)}, ` +
        `template/pnpm-workspace.yaml has ${JSON.stringify(pnpmVal)}. ` +
        `Keep them in sync so pnpm and npm scaffolds behave identically.`,
    );
  }
}

// @ast-grep/napi platform-specific optional dependency guard.
// The root optionalDependencies["@ast-grep/napi-linux-x64-gnu"] edge is a defensive
// measure against npm/cli#4828-style lockfile regeneration that can drop platform-specific
// optional dependencies. It makes the linux binary a direct root entry so the committed
// package-lock.json cannot lose it to regeneration. It MUST match
// devDependencies["@ast-grep/napi"] to stay in sync on version bumps.
const astGrepVersion = templateDeps["@ast-grep/napi"];
const astGrepLinuxVersion =
  templatePkg.optionalDependencies?.["@ast-grep/napi-linux-x64-gnu"];
if (astGrepVersion && astGrepLinuxVersion) {
  if (astGrepVersion !== astGrepLinuxVersion) {
    errors.push(
      `@ast-grep/napi version skew: devDependencies pins ${astGrepVersion}, ` +
        `but optionalDependencies[@ast-grep/napi-linux-x64-gnu] pins ${astGrepLinuxVersion}. ` +
        `Update optionalDependencies to match so the linux-x64-gnu binary version stays in sync.`,
    );
  }
} else if (astGrepVersion && !astGrepLinuxVersion) {
  errors.push(
    `@ast-grep/napi in devDependencies but ` +
      `optionalDependencies[@ast-grep/napi-linux-x64-gnu] is missing. ` +
      `Add optionalDependencies[@ast-grep/napi-linux-x64-gnu]=${astGrepVersion} ` +
      `to ensure npm deploys include the linux-x64-gnu binary edge.`,
  );
} else if (!astGrepVersion && astGrepLinuxVersion) {
  errors.push(
    `@ast-grep/napi missing from devDependencies but ` +
      `optionalDependencies[@ast-grep/napi-linux-x64-gnu]=${astGrepLinuxVersion}. ` +
      `Either add @ast-grep/napi to devDependencies or remove the optional entry.`,
  );
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
