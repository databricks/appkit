/** Orchestration for `appkit doctor`. */

import fs from "node:fs";
import path from "node:path";
import { originForEnvVars, readBundleInfo } from "./bundle";
import {
  type ConfigCheckContext,
  checkAuth,
  checkConfig,
  DEFAULT_ENV_FILE,
} from "./checks";
import { runExistenceProbe } from "./checks-existence";
import { checkWiring } from "./checks-wiring";
import {
  DEFAULT_MANIFEST_FILE,
  resolveTargetsFromCwd,
} from "./resolve-targets";
import {
  AUTH_UNAVAILABLE_CODE,
  BUNDLE_MANAGED_CODE,
  type CheckStatus,
  type DoctorOptions,
  type DoctorReport,
  type LayerResult,
  type ResourceCheckResult,
  type ResourceTarget,
  type SetupFinding,
  STATUS_SEVERITY,
} from "./types";
import { errorMessage, TimeoutError, withTimeout } from "./utils";

function worst(a: CheckStatus, b: CheckStatus): CheckStatus {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

async function checkResource(
  target: ResourceTarget,
  // undefined = auth failed, so the live existence layer is skipped.
  client: unknown,
  configCtx: ConfigCheckContext,
): Promise<ResourceCheckResult> {
  const layers: LayerResult[] = [];
  let rolled: CheckStatus = "ok";

  // A bundle-managed resource is checked before anything else, because neither
  // remaining layer can say anything true about it: its value comes from
  // `${resources.*}` at deploy time, so an unset env var locally is the *normal*
  // state (not a config error), and probing would be a false NOT_FOUND. A
  // mismatch between the three files is the wiring layer's job, and problems
  // inside databricks.yml are `databricks bundle validate`'s.
  //
  // This must run first: checking config here used to error on the unset var and
  // return early, never reaching this branch — which failed CI for a correctly
  // configured app while the report collapsed the row to a green-looking
  // "will be created on deploy" with the error hidden.
  if (target.origin === "bundle-managed") {
    return {
      target,
      status: "skipped",
      layers: [
        {
          layer: "existence",
          status: "skipped",
          code: BUNDLE_MANAGED_CODE,
          detail: "created by this bundle on deploy — not probed",
        },
      ],
    };
  }

  const configResult = checkConfig(target, configCtx);
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
      code: AUTH_UNAVAILABLE_CODE,
      detail: "skipped because workspace authentication failed",
    });
    rolled = worst(rolled, "skipped");
  } else {
    // A reachable-but-unresponsive endpoint must not hang doctor, so bound the
    // probe; a timeout becomes an error row rather than a hung process.
    const result = await withTimeout(runExistenceProbe(client, target)).catch(
      (err): LayerResult => ({
        layer: "existence",
        status: "error",
        code: err instanceof TimeoutError ? "PROBE_TIMEOUT" : "PROBE_FAILED",
        detail: `probe did not complete: ${errorMessage(err)}`,
      }),
    );
    layers.push(result);
    rolled = worst(rolled, result.status);
  }

  return { target, status: rolled, layers };
}

/**
 * Runs {@link checkResource} behind a guaranteed boundary: any unexpected throw
 * (a probe's own `.catch` handles the common case, but this covers config
 * errors and anything else) becomes a single error row instead of rejecting the
 * `Promise.all` and losing the entire report to a stack trace.
 */
async function checkResourceSafe(
  target: ResourceTarget,
  client: unknown,
  configCtx: ConfigCheckContext,
): Promise<ResourceCheckResult> {
  try {
    return await checkResource(target, client, configCtx);
  } catch (err) {
    return {
      target,
      status: "error",
      layers: [
        {
          layer: "existence",
          status: "error",
          code: "PROBE_EXCEPTION",
          detail: `unexpected error while checking: ${errorMessage(err)}`,
        },
      ],
    };
  }
}

/**
 * Checks doctor's own inputs, which otherwise produce a misleading report: run
 * from the wrong directory (say `server/` instead of the app root), nothing is
 * found and the result is a near-empty all-clear — a CI gate passing an app it
 * never looked at.
 *
 * The manifest is the signal for "this is an app root". Without it there's one
 * cause worth reporting (wrong directory), so it reports only that; a missing
 * `.env` would be noise on top. With it, a missing `.env` is worth its own notice
 * because local values could then only have come from the shell.
 *
 * Warnings, not errors: an app may legitimately have no `.env` (values exported
 * in the shell, or running in a deployed container), so this must not fail a
 * build on its own.
 */
export function checkSetup(
  cwd: string,
  options: DoctorOptions,
): SetupFinding[] {
  // Presence of the manifest, not the target count: a manifest that declares no
  // resources is legitimate and shouldn't be reported as a missing file.
  if (!fs.existsSync(path.join(cwd, DEFAULT_MANIFEST_FILE))) {
    return [
      {
        status: "warn",
        code: "NO_RESOURCES_CHECKED",
        label: "no resources checked",
        detail: `no ${DEFAULT_MANIFEST_FILE} found in ${cwd}, so no plugin resources were checked`,
        hint: `Run doctor from the app root (where ${DEFAULT_MANIFEST_FILE} lives), or run \`appkit plugin sync --write\` if it's missing.`,
      },
    ];
  }

  // An explicit --env-file that's missing already throws in the CLI, so only the
  // auto-loaded default is worth reporting here.
  if (!options.envFile && !fs.existsSync(path.join(cwd, DEFAULT_ENV_FILE))) {
    return [
      {
        status: "warn",
        code: "ENV_FILE_MISSING",
        label: DEFAULT_ENV_FILE,
        detail: `no ${DEFAULT_ENV_FILE} found in ${cwd} — local values can only come from the shell`,
        hint: `Create one (see .env.example), or pass --env-file <path>.`,
      },
    ];
  }

  return [];
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { result: auth, client } = await checkAuth(options);

  // Resolve and config-check resources even when auth failed, so a bad
  // connection still surfaces config problems instead of hiding them.
  const cwd = process.cwd();
  const targets = resolveTargetsFromCwd(cwd);

  const bundle = readBundleInfo(cwd);
  for (const target of targets) {
    const origin = originForEnvVars(target.envVars, bundle);
    if (origin) target.origin = origin;
  }

  // Name the file local values actually came from, and let the config layer see
  // the deploy wiring so it doesn't advise fixing what's already correct.
  const configCtx: ConfigCheckContext = {
    envFile: options.envFile ?? DEFAULT_ENV_FILE,
    wiredEnvVars: new Set(bundle.envToBinding.keys()),
  };

  const setup = checkSetup(cwd, options);

  // Probes are independent reads; Promise.all preserves order for a
  // deterministic report.
  const resources = await Promise.all(
    targets.map((target) => checkResourceSafe(target, client, configCtx)),
  );
  const wiring = checkWiring(bundle, targets);

  // The summary counts *everything* with a status — resources, the auth check,
  // wiring findings, and setup notices — so a --json consumer reading
  // summary.error can trust it, and the human/JSON outputs share one source of
  // truth.
  const summary = { ok: 0, warn: 0, error: 0, skipped: 0 };
  for (const result of resources) summary[result.status] += 1;
  summary[auth.status] += 1;
  for (const finding of wiring) summary[finding.status] += 1;
  for (const finding of setup) summary[finding.status] += 1;

  const exitCode = summary.error > 0 ? 1 : 0;

  return { auth, resources, wiring, setup, summary, exitCode };
}
