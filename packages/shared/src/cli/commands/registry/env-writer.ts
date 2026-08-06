import fs from "node:fs";
import path from "node:path";
import { isCancel, text } from "@clack/prompts";
import pc from "picocolors";
import {
  collectEnvNeeds,
  type EnvNeed,
  type EnvResolution,
  parseEnv,
  reconcileEnv,
  serializeEnvAppend,
  type ValueProvider,
} from "./env-reconcile";
import type { ResourceRequirementRow } from "./requirements";

export interface EnvSyncOptions {
  /** Directory holding `.env` / `.env.example` (the app root). */
  cwd: string;
  /** true = never prompt (agent/CI). Uses flag values or leaves unset. */
  nonInteractive: boolean;
  /** Pre-supplied env values from flags, e.g. { DATABRICKS_WAREHOUSE_ID: "abc" }. */
  values?: Record<string, string>;
}

/** Reads a `.env`-style file into a map; empty when the file is absent. */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, "utf-8"));
}

/** Appends text to a file, creating it (with a trailing newline) if needed. */
function appendToFile(file: string, text: string): void {
  if (text === "") return;
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf-8");
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, existing + sep + text);
  } else {
    fs.writeFileSync(file, text);
  }
}

/** Builds the value provider: flags first, then clack prompt (unless CI). */
function makeProvider(opts: EnvSyncOptions): ValueProvider {
  return async (need: EnvNeed) => {
    const fromFlag = opts.values?.[need.env];
    if (fromFlag !== undefined) return fromFlag;
    if (opts.nonInteractive) return undefined;

    const label = need.required
      ? `${need.env} (${need.resourceType}, required)`
      : `${need.env} (${need.resourceType}, optional)`;
    const answer = await text({
      message: label,
      placeholder: need.description ?? "leave blank to skip",
    });
    if (isCancel(answer)) return undefined;
    const value = (answer ?? "").trim();
    return value === "" ? undefined : value;
  };
}

/**
 * Reconciles a plugin's declared resource env vars into the app's local `.env`
 * (and mirrors variable names into `.env.example`). Never overwrites keys the
 * user already set; skips platform-injected fields. Returns the per-var
 * resolutions so callers can report what happened.
 */
export async function syncEnv(
  rows: ResourceRequirementRow[],
  opts: EnvSyncOptions,
): Promise<EnvResolution[]> {
  const needs = collectEnvNeeds(rows);
  if (needs.length === 0) return [];

  const envPath = path.join(opts.cwd, ".env");
  const examplePath = path.join(opts.cwd, ".env.example");
  const existing = readEnvFile(envPath);

  const resolutions = await reconcileEnv(needs, {
    existing,
    provide: makeProvider(opts),
  });

  const written = resolutions.filter(
    (r): r is EnvResolution & { value: string } =>
      r.status === "written" && r.value !== undefined,
  );
  appendToFile(
    envPath,
    serializeEnvAppend(written.map((r) => ({ env: r.env, value: r.value }))),
  );

  // .env.example carries the variable names (no secret values), and only for
  // vars not already documented there.
  const exampleExisting = readEnvFile(examplePath);
  const newExampleKeys = needs.filter((n) => !(n.env in exampleExisting));
  appendToFile(
    examplePath,
    serializeEnvAppend(newExampleKeys.map((n) => ({ env: n.env, value: "" }))),
  );

  return resolutions;
}

/** Prints a concise summary of what env reconciliation did. */
export function reportEnvResolutions(resolutions: EnvResolution[]): void {
  if (resolutions.length === 0) return;
  const written = resolutions.filter((r) => r.status === "written");
  const already = resolutions.filter((r) => r.status === "already-set");
  const skipped = resolutions.filter((r) => r.status === "skipped");

  if (written.length > 0) {
    console.log(
      `${pc.green("Wrote to .env:")} ${written.map((r) => r.env).join(", ")}`,
    );
  }
  if (already.length > 0) {
    console.log(pc.dim(`Already set: ${already.map((r) => r.env).join(", ")}`));
  }
  if (skipped.length > 0) {
    console.log(
      `${pc.yellow("Left unset (set before deploy):")} ${skipped
        .map((r) => r.env)
        .join(", ")}`,
    );
  }
}
