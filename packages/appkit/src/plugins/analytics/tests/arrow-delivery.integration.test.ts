import { WorkspaceClient } from "@databricks/sdk-experimental";
import { tableFromIPC } from "apache-arrow";
import { describe, expect, test } from "vitest";
import { SQLWarehouseConnector } from "../../../connectors";
import { deliverArrowBytes, type QueryExecutor } from "../result-delivery";

/**
 * Gated live integration test for the Arrow delivery fallback against a REAL
 * warehouse. Skipped unless `APPKIT_INTEGRATION_WAREHOUSE_ID` is set (with
 * `DATABRICKS_HOST`/`DATABRICKS_CONFIG_PROFILE` auth in the environment), so it
 * never runs in CI. Run locally, e.g.:
 *
 *   DATABRICKS_CONFIG_PROFILE=dogfood \
 *   APPKIT_INTEGRATION_WAREHOUSE_ID=86e2ab2c5d30b12a \
 *   pnpm exec vitest run arrow-delivery.integration
 *
 * Verifies the full capability fallback end-to-end: on a normal warehouse the
 * INLINE attempt is rejected and EXTERNAL_LINKS chunks stream through; on
 * Reyden the inline attachment streams. Column names are resolved from the
 * manifest either way.
 *
 * NOTE: this drives the service-principal identity. Full `.obo.sql` (user)
 * validation requires a user token / `x-forwarded-user` request and is
 * verified manually; the wiring is covered by the mocked OBO test in
 * `analytics.test.ts`.
 */
const warehouseId = process.env.APPKIT_INTEGRATION_WAREHOUSE_ID;

describe.runIf(!!warehouseId)("arrow delivery (live warehouse)", () => {
  test("ARROW_STREAM delivers valid Arrow with real column names", async () => {
    const client = new WorkspaceClient({});
    const connector = new SQLWarehouseConnector({ timeout: 120_000 });

    const executor: QueryExecutor = {
      query: async (statement, _params, fp, signal) => {
        const res = (await connector.executeStatement(
          client,
          {
            statement,
            warehouse_id: warehouseId as string,
            wait_timeout: "50s",
            on_wait_timeout: "CONTINUE",
            disposition: fp.disposition as never,
            format: fp.format as never,
          },
          signal,
        )) as { result?: unknown };
        return res.result as never;
      },
    };

    const out: { columnNames?: string[]; statementId?: string } = {};
    const chunks: Buffer[] = [];
    for await (const bytes of deliverArrowBytes(
      executor,
      connector,
      "SELECT id AS my_id, cast(id AS string) AS my_name FROM range(1000)",
      undefined,
      out,
    )) {
      chunks.push(Buffer.from(bytes));
    }

    const table = tableFromIPC(new Uint8Array(Buffer.concat(chunks)));
    expect(table.numRows).toBe(1000);
    expect(out.columnNames).toEqual(["my_id", "my_name"]);
  }, 180_000);
});
