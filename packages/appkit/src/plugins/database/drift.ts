import type { Pool } from "pg";
import type { Schema } from "../../database";
import {
  type DriftReport,
  diffIntrospections,
  introspect,
  schemaToIntrospection,
} from "../../database/introspector";
import { formatDriftResolution } from "../../database/introspector/drift-help";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database:drift");

interface DriftCheckOptions {
  pool: Pool;
  schema: Schema;
  enabled?: boolean;
  /** When true, swallow introspection errors instead of failing boot. */
  tolerateIntrospectionFailure?: boolean;
  nodeEnv?: string;
  introspectFn?: typeof introspect;
}

/**
 * Compare the live catalog against the convention-loaded schema.
 *
 * Dev: warn only. Prod: fail closed on fatal drift (`schema-only` or
 * `type-mismatch`); additive drift (`live-only`) is logged but allowed so
 * blue/green deploys aren't stalled by forward-running migrations.
 *
 * Transient introspection failures (failover, blips) are logged as
 * "drift unknown" — boot continues to avoid trading safety for availability.
 */
export async function checkDrift(
  options: DriftCheckOptions,
): Promise<DriftReport> {
  if (options.enabled === false) {
    return { hasDrift: false, entries: [] };
  }

  let live: Awaited<ReturnType<typeof introspect>>;
  try {
    live = await (options.introspectFn ?? introspect)(options.pool);
  } catch (err) {
    const isProd = (options.nodeEnv ?? process.env.NODE_ENV) === "production";
    // Fail closed in prod (Migration 4x #28) unless the caller opted in.
    // Swallowing here would mask a missing-table migration as "no drift".
    if (isProd && !options.tolerateIntrospectionFailure) {
      throw new ConfigurationError(
        "Database drift introspection failed; refusing to boot in production. Set tolerateSetupFailure to override.",
        { cause: err instanceof Error ? err : undefined },
      );
    }
    logger.warn(
      "Drift check skipped — introspection failed (treating as drift-unknown): %O",
      err,
    );
    return { hasDrift: false, entries: [] };
  }

  const declared = schemaToIntrospection(options.schema);
  const report = diffIntrospections(live, declared);

  if (!report.hasDrift) return report;

  const fatal = report.entries.filter(
    (entry) =>
      entry.severity === "error" ||
      entry.kind === "schema-only" ||
      entry.kind === "type-mismatch",
  );
  const message = formatDrift(report);

  if (fatal.length === 0) {
    logger.warn("Database schema drift (non-fatal):\n%s", message);
    return report;
  }

  if ((options.nodeEnv ?? process.env.NODE_ENV) === "production") {
    throw new ConfigurationError(
      `Database schema drift detected. Refusing to boot in production.\n\n${message}`,
    );
  }

  logger.warn("Database schema drift detected:\n%s", message);
  return report;
}

function formatDrift(report: DriftReport): string {
  return [
    ...report.entries.map((entry) => `   ${entry.message}`),
    "",
    formatDriftResolution({ includeVerify: true }),
  ].join("\n");
}
