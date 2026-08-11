/**
 * Layer: wiring (offline, deploy-declaration). Validates the three-file join
 * that `databricks bundle validate` can't see, because it spans `app.yaml` and
 * the AppKit plugin layer:
 *
 *  - every `app.yaml` `valueFrom: <name>` must match a `databricks.yml` binding
 *    `name` — otherwise the platform has nothing to inject and the env var the
 *    plugin reads stays empty at runtime;
 *  - every bundle-managed `${resources.<type>.<key>.*}` binding must reference a
 *    resource actually declared in the bundle — otherwise deploy fails.
 *
 * Runs regardless of auth; these are declaration problems, not connectivity.
 */

import type { BundleInfo } from "./bundle";
import type { ResourceTarget, WiringFinding } from "./types";

export function checkWiring(
  info: BundleInfo,
  targets: ResourceTarget[],
): WiringFinding[] {
  if (!info.present) return [];

  const findings: WiringFinding[] = [];

  // 1. Each app.yaml valueFrom must resolve to a real binding.
  for (const [envVar, bindingName] of info.envToBinding) {
    if (!info.bindings.has(bindingName)) {
      findings.push({
        status: "error",
        code: "VALUEFROM_UNBOUND",
        label: envVar,
        detail: `app.yaml binds it to "${bindingName}", which databricks.yml doesn't declare`,
        hint: `Add a resource named "${bindingName}" under resources.apps.<app>.resources, or fix the valueFrom to match an existing binding.`,
      });
    }
  }

  // 2. Each bundle-managed binding must reference a declared bundle resource.
  for (const binding of info.bindings.values()) {
    if (binding.origin !== "bundle-managed" || !binding.ref) continue;
    const ref = `${binding.ref.type}.${binding.ref.key}`;
    if (!info.declaredResources.has(ref)) {
      findings.push({
        status: "error",
        code: "BUNDLE_REF_MISSING",
        label: binding.name,
        detail: `references \${resources.${ref}.*}, but no resources.${binding.ref.type}.${binding.ref.key} is declared in the bundle`,
        hint: `Declare resources.${binding.ref.type}.${binding.ref.key} in databricks.yml, or point the binding at an existing resource.`,
      });
    }
  }

  // 3. A used plugin's env var with no app.yaml entry: set locally via .env, but
  // .env isn't uploaded and the platform injects only what app.yaml maps, so the
  // var is absent from the deployed app's environment — the headline "works
  // locally, breaks on deploy" case. For a *required* resource this guarantees a
  // broken deploy, so it's an error that gates the exit code; for an optional one
  // it's a warning.
  for (const target of targets) {
    for (const envVar of target.envVars) {
      if (!info.envToBinding.has(envVar)) {
        findings.push({
          status: target.required ? "error" : "warn",
          code: "ENV_UNWIRED",
          label: envVar,
          detail: `has no app.yaml entry — it won't be set in the environment of the deployed app${
            target.required ? "" : " (optional)"
          }`,
          hint: `Add to app.yaml: \`{ name: ${envVar}, valueFrom: <binding> }\`, and declare that binding in databricks.yml.`,
        });
      }
    }
  }

  return findings;
}
