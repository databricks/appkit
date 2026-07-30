/**
 * Orchestration for `appkit doctor`.
 *
 * Resolves the resources the app declares, overlays bundle provenance, runs the
 * app-wide auth check once, then per resource runs the offline `config` layer
 * followed by the live `existence` layer — except for bundle-managed resources,
 * whose existence can't be probed before deploy. Separately runs the offline
 * wiring check (deploy-declaration consistency). Rolls everything into a
 * {@link DoctorReport}.
 */

import { originForEnvVars, readBundleInfo } from "./bundle";
import { checkAuth, checkConfig, checkExistence } from "./checks";
import { checkWiring } from "./checks-wiring";
import { resolveTargetsFromCwd } from "./resolve-targets";
import type {
  CheckStatus,
  DoctorOptions,
  DoctorReport,
  LayerResult,
  ResourceCheckResult,
  ResourceTarget,
} from "./types";

const STATUS_SEVERITY: Record<CheckStatus, number> = {
  ok: 0,
  skipped: 1,
  warn: 2,
  error: 3,
};

function worst(a: CheckStatus, b: CheckStatus): CheckStatus {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

async function checkResource(
  target: ResourceTarget,
  // undefined = auth failed, so the live existence layer is skipped.
  client: unknown,
): Promise<ResourceCheckResult> {
  const layers: LayerResult[] = [];
  let rolled: CheckStatus = "ok";

  const configResult = await checkConfig(target);
  layers.push(configResult);
  rolled = worst(rolled, configResult.status);
  // A hard config failure makes the existence probe meaningless.
  if (configResult.status === "error") {
    return { target, status: rolled, layers };
  }

  // A bundle-managed resource doesn't exist until `bundle deploy`, so probing it
  // would be a false NOT_FOUND. Report it as deploy-managed instead.
  if (target.origin === "bundle-managed") {
    layers.push({
      layer: "existence",
      status: "skipped",
      code: "BUNDLE_MANAGED",
      detail: "created by this bundle on deploy — not probed",
    });
    return { target, status: worst(rolled, "skipped"), layers };
  }

  if (client === undefined) {
    layers.push({
      layer: "existence",
      status: "skipped",
      code: "AUTH_UNAVAILABLE",
      detail: "skipped because workspace authentication failed",
    });
    rolled = worst(rolled, "skipped");
  } else {
    const result = await checkExistence(target, client);
    layers.push(result);
    rolled = worst(rolled, result.status);
  }

  return { target, status: rolled, layers };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { result: auth, client } = await checkAuth(options);

  const summary = { ok: 0, warn: 0, error: 0, skipped: 0 };
  const resources: ResourceCheckResult[] = [];

  // Resources are resolved and config-checked even when auth failed, so a bad
  // connection still surfaces config problems instead of hiding them all.
  const cwd = process.cwd();
  const targets = resolveTargetsFromCwd(cwd, options.manifest);

  // Overlay bundle provenance (Phase 1) and gather wiring info (Phase 2).
  const bundle = readBundleInfo(cwd);
  for (const target of targets) {
    const origin = originForEnvVars(target.envVars, bundle);
    if (origin) target.origin = origin;
  }

  // Probes are independent reads, so run them concurrently; Promise.all
  // preserves input order, keeping the report deterministic.
  const results = await Promise.all(
    targets.map((target) => checkResource(target, client)),
  );
  for (const result of results) {
    resources.push(result);
    summary[result.status] += 1;
  }

  const wiring = checkWiring(bundle, targets);

  return { auth, resources, wiring, summary };
}
