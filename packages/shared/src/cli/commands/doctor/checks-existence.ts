/**
 * Layer: existence — per-resource-type probes that prove a declared resource
 * exists and is reachable via the cheapest read the SDK offers.
 *
 * The client is typed structurally (not via the SDK) so `shared` stays SDK-free.
 */

import {
  AppkitNotInstalledError,
  getLakebasePool,
  type LakebasePoolHandle,
} from "./databricks-client";
import type { LayerResult, ResourceTarget } from "./types";

interface DoctorWorkspaceClient {
  warehouses: {
    get: (r: { id: string }) => Promise<{ state?: string }>;
  };
  servingEndpoints: {
    get: (r: { name: string }) => Promise<unknown>;
  };
  genie: {
    getSpace: (r: { space_id: string }) => Promise<unknown>;
  };
  jobs: {
    get: (r: { job_id: number }) => Promise<unknown>;
  };
  volumes: {
    read: (r: { name: string }) => Promise<unknown>;
  };
  vectorSearchIndexes: {
    getIndex: (r: { index_name: string }) => Promise<unknown>;
  };
  functions: {
    get: (r: { name: string }) => Promise<unknown>;
  };
}

type ExistenceProbe = (
  client: DoctorWorkspaceClient,
  target: ResourceTarget,
) => Promise<LayerResult>;

// The SDK's ApiError carries statusCode/errorCode; we read them off the caught
// error structurally rather than importing the class, keeping `shared` SDK-free.
function statusCodeOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "errorCode" in err) {
    const code = (err as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

// The SDK message often embeds a JSON blob (`Response from server (...)
// {"message":"..."}`); pull the inner `message` out so doctor prints one clean
// line, not a dump.
function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : raw;
}

function classifyError(err: unknown, target: ResourceTarget): LayerResult {
  const status = statusCodeOf(err);
  const errorCode = errorCodeOf(err);
  const message = cleanMessage(err);

  if (status === 404 || errorCode === "RESOURCE_DOES_NOT_EXIST") {
    return {
      layer: "existence",
      status: "error",
      code: "NOT_FOUND",
      detail: `${target.type} not found — check the configured id/name (${message})`,
    };
  }
  // A malformed id/name often comes back as 400 rather than 404.
  if (status === 400 || errorCode === "INVALID_PARAMETER_VALUE") {
    return {
      layer: "existence",
      status: "error",
      code: "INVALID_VALUE",
      detail: `invalid ${target.type} id/name: ${message}`,
    };
  }
  if (status === 403 || errorCode === "PERMISSION_DENIED") {
    return {
      layer: "existence",
      status: "error",
      code: "ACCESS_DENIED",
      detail: `access denied reading ${target.type} — the identity may lack visibility (${message})`,
    };
  }
  return {
    layer: "existence",
    status: "error",
    code: "PROBE_FAILED",
    detail: `failed to read ${target.type}: ${message}`,
  };
}

/** Normalizes a field key for comparison: manifests use camelCase (`indexName`)
 * while scaffold defaults use snake_case (`index_name`), so match case- and
 * separator-insensitively. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Looks up a resolved field value by any of the accepted key spellings. */
function field(target: ResourceTarget, ...names: string[]): string | null {
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(target.fieldValues)) {
    if (wanted.has(normalizeKey(key)) && value.length > 0) return value;
  }
  return null;
}

function missingField(fieldName: string): LayerResult {
  return {
    layer: "existence",
    status: "skipped",
    code: "MISSING_FIELD",
    detail: `cannot probe existence: no resolved value for "${fieldName}"`,
  };
}

const probeWarehouse: ExistenceProbe = async (client, target) => {
  const id = field(target, "id");
  if (!id) return missingField("id");
  try {
    const wh = await client.warehouses.get({ id });
    const state = wh.state;
    if (state && state !== "RUNNING") {
      return {
        layer: "existence",
        status: "warn",
        code: "WAREHOUSE_NOT_RUNNING",
        detail: `warehouse exists but is ${state} (will cold-start on first query)`,
      };
    }
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeServing: ExistenceProbe = async (client, target) => {
  const name = field(target, "name");
  // Serving endpoints are looked up by name. If the manifest instead keys this
  // resource by `id`, we still probe with that value but flag the likely cause
  // when it fails, since the API only accepts a name.
  const idOnly = name === null ? field(target, "id") : null;
  const value = name ?? idOnly;
  if (!value) return missingField("name");
  try {
    await client.servingEndpoints.get({ name: value });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    const result = classifyError(err, target);
    if (idOnly && result.status === "error") {
      result.hint =
        "Serving endpoints are looked up by name, but this resource is configured by id. Set DATABRICKS_SERVING_ENDPOINT_NAME to the endpoint's name.";
    }
    return result;
  }
};

const probeGenie: ExistenceProbe = async (client, target) => {
  const spaceId = field(target, "id");
  if (!spaceId) return missingField("id");
  try {
    await client.genie.getSpace({ space_id: spaceId });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeJob: ExistenceProbe = async (client, target) => {
  const raw = field(target, "id");
  if (!raw) return missingField("id");
  const jobId = Number(raw);
  if (!Number.isInteger(jobId)) {
    return {
      layer: "existence",
      status: "error",
      code: "INVALID_ID",
      detail: `job id is not a valid integer: "${raw}"`,
    };
  }
  try {
    await client.jobs.get({ job_id: jobId });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeVolume: ExistenceProbe = async (client, target) => {
  // The read API wants the 3-level name (catalog.schema.volume), but the env
  // value is usually a /Volumes/... path.
  const raw = field(target, "path", "name");
  if (!raw) return missingField("path");
  const name = toThreeLevelVolumeName(raw);
  if (!name) {
    return {
      layer: "existence",
      status: "error",
      code: "INVALID_NAME",
      detail: `cannot derive a 3-level volume name from "${raw}"`,
    };
  }
  try {
    await client.volumes.read({ name });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeVectorIndex: ExistenceProbe = async (client, target) => {
  const name = field(target, "indexName", "index_name", "name");
  if (!name) return missingField("indexName");
  try {
    await client.vectorSearchIndexes.getIndex({ index_name: name });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeFunction: ExistenceProbe = async (client, target) => {
  const name = field(target, "name");
  if (!name) return missingField("name");
  try {
    await client.functions.get({ name });
    return { layer: "existence", status: "ok" };
  } catch (err) {
    return classifyError(err, target);
  }
};

// Lakebase authenticates with an OAuth token as the Postgres password, so
// "password authentication failed" almost never means a wrong password — it
// usually means PGUSER doesn't match the token's identity.
function lakebaseAuthHint(message: string): string | undefined {
  if (/password authentication failed/i.test(message)) {
    return (
      "Lakebase uses an OAuth token as the password, so this usually means the" +
      " PGUSER/role doesn't match your identity. Check PGUSER is your exact" +
      " login (the literal `user@domain`, not URL-encoded)."
    );
  }
  return undefined;
}

// Lakebase has no cheap control-plane `.get()`, so existence is proven by a
// real connection + `SELECT 1` (exercising endpoint resolution, OAuth token
// mint, TLS, and reachability — the same path the app uses).
const probePostgres: ExistenceProbe = async (client, target) => {
  if (!field(target, "endpointPath") && !field(target, "host")) {
    return missingField("host/endpoint");
  }

  let pool: LakebasePoolHandle | null = null;
  try {
    pool = await getLakebasePool(client);
    await pool.query("SELECT 1");
    return { layer: "existence", status: "ok" };
  } catch (err) {
    if (err instanceof AppkitNotInstalledError) {
      return {
        layer: "existence",
        status: "skipped",
        code: "APPKIT_NOT_INSTALLED",
        detail: err.message,
      };
    }
    const message = cleanMessage(err);
    return {
      layer: "existence",
      status: "error",
      code: "CONNECTION_FAILED",
      detail: `could not connect to Lakebase Postgres: ${message}`,
      hint: lakebaseAuthHint(message),
    };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // best-effort close
      }
    }
  }
};

/**
 * Normalizes a volume reference to the SDK's 3-level `catalog.schema.volume`
 * name, accepting either an already-dotted name or a `/Volumes/c/s/v/...` path.
 */
export function toThreeLevelVolumeName(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[^./\s]+\.[^./\s]+\.[^./\s]+$/.test(trimmed)) return trimmed;

  const m = trimmed.match(/^\/Volumes\/([^/]+)\/([^/]+)\/([^/]+)/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;

  return null;
}

// Types not listed (secret, uc_connection, database, app, experiment) have no
// probe and fall through to NOT_IMPLEMENTED in runExistenceProbe.
const PROBES: Record<string, ExistenceProbe> = {
  sql_warehouse: probeWarehouse,
  serving_endpoint: probeServing,
  genie_space: probeGenie,
  job: probeJob,
  volume: probeVolume,
  vector_search_index: probeVectorIndex,
  uc_function: probeFunction,
  postgres: probePostgres,
};

export async function runExistenceProbe(
  client: unknown,
  target: ResourceTarget,
): Promise<LayerResult> {
  const probe = PROBES[target.type];
  if (!probe) {
    return {
      layer: "existence",
      status: "skipped",
      code: "NOT_IMPLEMENTED",
      detail: `existence check not implemented for ${target.type}`,
    };
  }
  return probe(client as DoctorWorkspaceClient, target);
}
