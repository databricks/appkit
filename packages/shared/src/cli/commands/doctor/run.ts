/**
 * Orchestration for `appkit doctor`.
 *
 * Resolves the resources the app declares, runs the app-wide auth check once,
 * then per resource runs the offline `config` layer followed by the live
 * `existence` layer. Rolls everything up into a {@link DoctorReport}.
 */

import { checkAuth, checkConfig, checkExistence } from "./checks";
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
  // Probes are independent reads, so run them concurrently; Promise.all
  // preserves input order, keeping the report deterministic.
  const targets = resolveTargetsFromCwd(process.cwd(), options.manifest);
  const results = await Promise.all(
    targets.map((target) => checkResource(target, client)),
  );
  for (const result of results) {
    resources.push(result);
    summary[result.status] += 1;
  }

  return { auth, resources, summary };
}
