import type { ManifestResource } from "./plan";

/**
 * Derived values for fields with a `resolve` key, a port of the Databricks
 * CLI's ResolvePostgresValues (libs/apps/prompt): the branch's read-write
 * endpoint gives `postgres:host` and `postgres:endpointPath`, the database
 * gives `postgres:databaseName`. Returns `resourceKey.field` → value for the
 * fields it could resolve; throws on API errors.
 */
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
