import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { SQLWarehouseConnector } from "../connectors";

/**
 * One row of a managed evaluation dataset. `inputs` are the kwargs passed to the
 * agent for the turn; `expectations` (when present) is the row's ground truth /
 * guidelines. Mirrors the `{inputs, expectations}` shape of `mlflow.genai`
 * datasets and of the Unity Catalog table backing a managed eval dataset.
 */
export interface DatasetRow {
  inputs: Record<string, unknown>;
  expectations?: Record<string, unknown>;
}

export interface ReadEvalDatasetOptions {
  /** Fully-qualified UC table: `catalog.schema.table`. */
  table: string;
  /** SQL warehouse id to run the read against. */
  warehouseId: string;
  /** Optional row cap. */
  limit?: number;
}

/** A managed eval dataset is a UC table; only 3-level names are valid. */
const UC_TABLE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

/** Coerce a cell (already JSON-parsed by the connector for JSON columns) to a record. */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Read a Databricks managed evaluation dataset (a Unity Catalog table with
 * `inputs`/`expectations` columns) into rows, over the public SQL Statement
 * Execution API. Reuses {@link SQLWarehouseConnector} for submit/poll/transform
 * — its result transform already JSON-parses string columns into objects, so
 * `inputs`/`expectations` come back as records whether the table stores them as
 * JSON strings or structs.
 *
 * The Python `mlflow.genai.datasets` API needs a Spark session (no TS
 * equivalent), so we read the backing table directly.
 */
export async function readEvalDataset(
  client: WorkspaceClient,
  options: ReadEvalDatasetOptions,
): Promise<DatasetRow[]> {
  if (!UC_TABLE.test(options.table)) {
    throw new Error(
      `Invalid dataset table "${options.table}" — expected catalog.schema.table`,
    );
  }

  const limit =
    typeof options.limit === "number"
      ? ` LIMIT ${Math.floor(options.limit)}`
      : "";
  const connector = new SQLWarehouseConnector({});
  const response = await connector.executeStatement(client, {
    warehouse_id: options.warehouseId,
    statement: `SELECT inputs, expectations FROM ${options.table}${limit}`,
  });

  const rows =
    (response.result as { data?: Array<Record<string, unknown>> } | undefined)
      ?.data ?? [];

  return rows.map((row) => ({
    inputs: toRecord(row.inputs) ?? {},
    expectations: toRecord(row.expectations),
  }));
}
