import { expect, test, vi } from "vitest";

import type { ManifestResource } from "./plan";
import { discoverIndexColumns, resolveDerivedValues } from "./resolve";

const listEndpointsIter = vi.fn(async function* () {
  yield { name: "ro", status: { endpointType: "ENDPOINT_TYPE_READ_ONLY" } };
  yield {
    name: "b/endpoints/rw",
    status: { endpointType: "ENDPOINT_TYPE_READ_WRITE", hosts: { host: "h" } },
  };
});
const listDatabasesIter = vi.fn(async function* () {
  yield { name: "b/databases/db", status: { postgresDatabase: "appdb" } };
});
vi.mock("../../registry/workspace-picker.js", () => ({
  makeWorkspaceClient: () => ({
    postgres: { listEndpointsIter, listDatabasesIter },
    vectorSearch: {
      getVectorIndex: async () => ({
        indexSpec: {
          $case: "deltaSyncIndexSpec",
          deltaSyncIndexSpec: {
            sourceTable: "c.s.t",
            embeddingVectorColumns: [{ name: "vec" }],
          },
        },
      }),
    },
    tables: {
      getTable: async () => ({ columns: [{ name: "id" }, { name: "vec" }] }),
    },
  }),
}));

const pg: ManifestResource = {
  type: "postgres",
  alias: "Postgres",
  resourceKey: "postgres",
  fields: {
    branch: {},
    database: {},
    host: { env: "PGHOST", resolve: "postgres:host" },
    databaseName: { env: "PGDATABASE", resolve: "postgres:databaseName" },
    endpointPath: {
      env: "LAKEBASE_ENDPOINT",
      resolve: "postgres:endpointPath",
    },
  },
};

test("maps the read-write endpoint and database to resolver fields", async () => {
  const values = {
    "postgres.branch": "b",
    "postgres.database": "b/databases/db",
  };
  expect(await resolveDerivedValues(pg, values, undefined)).toEqual({
    "postgres.host": "h",
    "postgres.databaseName": "appdb",
    "postgres.endpointPath": "b/endpoints/rw",
  });
});

test("skips the API when every derived field is set", async () => {
  listEndpointsIter.mockClear();
  await resolveDerivedValues(
    pg,
    {
      "postgres.branch": "b",
      "postgres.host": "x",
      "postgres.databaseName": "x",
      "postgres.endpointPath": "x",
    },
    undefined,
  );
  expect(listEndpointsIter).not.toHaveBeenCalled();
});

test("discoverIndexColumns drops embedding columns", async () => {
  expect(await discoverIndexColumns("c.s.i", undefined)).toEqual(["id"]);
});
