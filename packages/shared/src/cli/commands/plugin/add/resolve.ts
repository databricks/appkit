import type { ManifestResource } from "./plan";

/** Values for `postgres:*` resolver fields, as the Databricks CLI's ResolvePostgresValues. */
export async function resolveDerivedValues(
  r: ManifestResource,
  values: Record<string, string>,
  profile: string | undefined,
): Promise<Record<string, string>> {
  const branch = values[`${r.resourceKey}.branch`];
  const database = values[`${r.resourceKey}.database`];
  const needs = Object.entries(r.fields ?? {}).some(
    ([name, f]) =>
      f.resolve?.startsWith("postgres:") && !values[`${r.resourceKey}.${name}`],
  );
  if (r.type !== "postgres" || !needs || !branch) return {};

  const { makeWorkspaceClient } =
    await import("../../registry/workspace-picker.js");
  const pg = makeWorkspaceClient(profile).postgres;
  const resolved: Record<string, string> = {};
  for await (const ep of pg.listEndpointsIter({ parent: branch })) {
    if (ep.status?.endpointType !== "ENDPOINT_TYPE_READ_WRITE") continue;
    if (ep.name) resolved["postgres:endpointPath"] = ep.name;
    if (ep.status.hosts?.host) resolved["postgres:host"] = ep.status.hosts.host;
    break;
  }
  if (database) {
    for await (const db of pg.listDatabasesIter({ parent: branch })) {
      if (db.name !== database) continue;
      if (db.status?.postgresDatabase) {
        resolved["postgres:databaseName"] = db.status.postgresDatabase;
      }
      break;
    }
  }

  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(r.fields ?? {})) {
    const v = field.resolve && resolved[field.resolve];
    if (v) out[`${r.resourceKey}.${name}`] = v;
  }
  return out;
}

/** An AI Search index's synced source columns, minus embedding vectors. */
export async function discoverIndexColumns(
  indexName: string,
  profile: string | undefined,
): Promise<string[]> {
  const { makeWorkspaceClient } =
    await import("../../registry/workspace-picker.js");
  const client = makeWorkspaceClient(profile);
  const index = await client.vectorSearch.getVectorIndex({ name: indexName });
  const spec =
    index.indexSpec?.$case === "deltaSyncIndexSpec"
      ? index.indexSpec.deltaSyncIndexSpec
      : undefined;
  if (!spec?.sourceTable) {
    throw new Error(`index ${indexName} has no Delta Sync source table`);
  }
  const excluded = new Set(spec.embeddingVectorColumns?.map((c) => c.name));
  const table = await client.tables.getTable({ fullNameArg: spec.sourceTable });
  // columnsToIndex is the response's alias of columnsToSync.
  const subset = spec.columnsToSync?.length
    ? spec.columnsToSync
    : spec.columnsToIndex;
  const synced = subset?.length ? new Set(subset) : undefined;
  return (table.columns ?? []).flatMap((c) =>
    c.name && !excluded.has(c.name) && (!synced || synced.has(c.name))
      ? [c.name]
      : [],
  );
}
