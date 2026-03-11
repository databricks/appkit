/**
 * MLflow experiment trace location setup.
 *
 * Auto-provisions Unity Catalog trace storage and links an MLflow experiment
 * to it using the Databricks REST API.  This mirrors the Python
 * `mlflow.set_experiment_trace_location()` behaviour.
 *
 * Env vars:
 *   OTEL_UC_TABLE_NAME — fully-qualified UC table (catalog.schema.table);
 *                        catalog and schema are derived by splitting on dots.
 *   MLFLOW_TRACING_SQL_WAREHOUSE_ID — warehouse used to create the storage (optional)
 */

import { createLogger } from "../../logging/logger";

const logger = createLogger("agent:mlflow");

interface TraceLocationOptions {
  experimentId: string;
  /** Derived from OTEL_UC_TABLE_NAME by the caller (first dot-segment). */
  ucCatalog?: string;
  /** Derived from OTEL_UC_TABLE_NAME by the caller (second dot-segment). */
  ucSchema?: string;
  warehouseId?: string;
}

const MLFLOW_TRACE_LOCATION_TABLE_NAME = "mlflow_experiment_trace_otel_spans";

/**
 * Link an MLflow experiment to an existing UC trace location.
 * Returns the fully-qualified table name on success, `null` otherwise.
 */
async function linkExperimentToLocation(
  client: { apiClient: { request: (opts: unknown) => Promise<unknown> } },
  experimentId: string,
  catalogName: string,
  schemaName: string,
): Promise<string | null> {
  const tableName = `${catalogName}.${schemaName}.${MLFLOW_TRACE_LOCATION_TABLE_NAME}`;

  try {
    await client.apiClient.request({
      path: `/api/4.0/mlflow/traces/${experimentId}/link-location`,
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      payload: {
        experiment_id: experimentId,
        uc_schema: {
          catalog_name: catalogName,
          schema_name: schemaName,
        },
      },
      raw: false,
    });

    logger.info("Experiment linked to UC trace location: %s", tableName);
    return tableName;
  } catch (error: unknown) {
    const code =
      (error as { error_code?: string }).error_code ??
      (error as Error).name ??
      "UNKNOWN";
    logger.warn(
      "Could not link experiment %s to %s (%s)",
      experimentId,
      tableName,
      code,
    );
    return null;
  }
}

/**
 * Provision a UC trace storage location and link the experiment to it.
 *
 * If `warehouseId` is not provided, the function attempts to link directly
 * (works when the UC table already exists).
 *
 * Returns the fully-qualified UC table name on success, `null` otherwise.
 */
export async function setupExperimentTraceLocation(
  opts: TraceLocationOptions,
): Promise<string | null> {
  const catalogName = opts.ucCatalog;
  const schemaName = opts.ucSchema;

  if (!catalogName || !schemaName) {
    logger.debug(
      "Skipping trace location setup — catalog/schema not available (set OTEL_UC_TABLE_NAME as catalog.schema.table)",
    );
    return null;
  }

  const warehouseId =
    opts.warehouseId ?? process.env.MLFLOW_TRACING_SQL_WAREHOUSE_ID;

  let client: {
    apiClient: { request: (opts: unknown) => Promise<unknown> };
    config: { ensureResolved: () => Promise<void> };
  };
  try {
    const { WorkspaceClient } = await import("@databricks/sdk-experimental");
    client = new WorkspaceClient({}) as typeof client;
    await client.config.ensureResolved();
  } catch (err) {
    logger.warn(
      "Cannot set up trace location — Databricks auth unavailable: %O",
      err,
    );
    return null;
  }

  if (!warehouseId) {
    const result = await linkExperimentToLocation(
      client,
      opts.experimentId,
      catalogName,
      schemaName,
    );
    if (!result) {
      logger.warn(
        "Trace destination does not exist and cannot be created — " +
          "set MLFLOW_TRACING_SQL_WAREHOUSE_ID to auto-create it",
      );
    }
    return result;
  }

  try {
    logger.debug(
      "Creating UC trace location: %s.%s (warehouse=%s)",
      catalogName,
      schemaName,
      warehouseId,
    );

    await client.apiClient.request({
      path: "/api/4.0/mlflow/traces/location",
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      payload: {
        uc_schema: {
          catalog_name: catalogName,
          schema_name: schemaName,
        },
        sql_warehouse_id: warehouseId,
      },
      raw: false,
    });

    return linkExperimentToLocation(
      client,
      opts.experimentId,
      catalogName,
      schemaName,
    );
  } catch (error: unknown) {
    // 409 = location already exists — just link
    if (
      error instanceof Error &&
      (error.message?.includes("409") ||
        error.message?.includes("ALREADY_EXISTS"))
    ) {
      return linkExperimentToLocation(
        client,
        opts.experimentId,
        catalogName,
        schemaName,
      );
    }
    logger.warn("Failed to create UC trace location: %O", error);
    return null;
  }
}
