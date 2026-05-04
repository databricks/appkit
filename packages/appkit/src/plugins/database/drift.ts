import type { Pool } from "pg";
import type { Schema } from "../../database";
import {
  type DriftReport,
  diffIntrospections,
  introspect,
  schemaToIntrospection,
} from "../../database/introspector";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database:drift");

interface DriftCheckOptions {
  pool: Pool;
  schema: Schema;
  enabled?: boolean;
  nodeEnv?: string;
  introspectFn?: typeof introspect;
}

/**
 * Compares the live database catalog against the convention-loaded schema.
 *
 * Development only warns so local iteration can continue. Production fails
 * closed on fatal drift — `schema-only` (column/table declared but missing
 * in db) or `type-mismatch`. Additive drift (`live-only`: db has extra
 * tables/columns the code doesn't know about) is logged but does not block
 * boot, so blue/green and rolling deploys are not stalled by a forward-running
 * migration on the other side.
 */
export async function checkDrift(
  options: DriftCheckOptions,
): Promise<DriftReport> {
  if (options.enabled === false) {
    return { hasDrift: false, entries: [] };
  }

  const live = await (options.introspectFn ?? introspect)(options.pool);
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
    "Resolve with one of:",
    "   npx appkit db migrate up",
    "   npx appkit db introspect --merge",
    "   npx appkit db verify --explain",
  ].join("\n");
}
