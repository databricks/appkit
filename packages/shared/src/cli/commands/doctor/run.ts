/** Orchestration for `appkit doctor`. */

import { originForEnvVars, readBundleInfo } from "./bundle";
import { checkAuth, checkConfig } from "./checks";
import { runExistenceProbe } from "./checks-existence";
import { checkWiring } from "./checks-wiring";
import { resolveTargetsFromCwd } from "./resolve-targets";
import {
  AUTH_UNAVAILABLE_CODE,
  type CheckStatus,
  type DoctorOptions,
  type DoctorReport,
  type LayerResult,
  type ResourceCheckResult,
  type ResourceTarget,
  STATUS_SEVERITY,
} from "./types";

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

  // A bundle-managed resource doesn't exist until deploy, so probing would be a
  // false NOT_FOUND.
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
      code: AUTH_UNAVAILABLE_CODE,
      detail: "skipped because workspace authentication failed",
    });
    rolled = worst(rolled, "skipped");
  } else {
    const result = await runExistenceProbe(client, target);
    layers.push(result);
    rolled = worst(rolled, result.status);
  }

  return { target, status: rolled, layers };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { result: auth, client } = await checkAuth(options);

  const summary = { ok: 0, warn: 0, error: 0, skipped: 0 };

  // Resolve and config-check resources even when auth failed, so a bad
  // connection still surfaces config problems instead of hiding them.
  const cwd = process.cwd();
  const targets = resolveTargetsFromCwd(cwd);

  const bundle = readBundleInfo(cwd);
  for (const target of targets) {
    const origin = originForEnvVars(target.envVars, bundle);
    if (origin) target.origin = origin;
  }

  // Probes are independent reads; Promise.all preserves order for a
  // deterministic report.
  const resources = await Promise.all(
    targets.map((target) => checkResource(target, client)),
  );
  for (const result of resources) {
    summary[result.status] += 1;
  }

  return { auth, resources, wiring: checkWiring(bundle, targets), summary };
}
