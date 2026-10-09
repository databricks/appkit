/**
 * Layer: existence — per-resource-type probes that prove a declared resource
 * exists and is reachable via the cheapest read the SDK offers.
 *
 * The client is typed structurally (the facade's modular clients + `request()`).
 */

import {
  AppkitNotInstalledError,
  getLakebasePool,
  type LakebasePoolHandle,
} from "./databricks-client";
import type { LayerResult, ResourceTarget } from "./types";
import { errorMessage } from "./utils";

/** A passing existence check. Shared, never mutated by callers. */
const EXISTENCE_OK: LayerResult = { layer: "existence", status: "ok" };

interface DoctorWorkspaceClient {
  warehouses: {
    getWarehouse: (r: { id: string }) => Promise<{ state?: string }>;
  };
  genie: {
    genieGetSpace: (r: { spaceId: string }) => Promise<unknown>;
  };
  jobs: {
    getJob: (r: { jobId: bigint }) => Promise<unknown>;
  };
  vectorSearch: {
    getVectorIndex: (r: { name: string }) => Promise<unknown>;
  };
  /** Raw REST GET for services the facade has no modular client for yet
   * (serving, volumes, UC functions). Throws on non-2xx. */
  request: (r: { method: string; path: string }) => Promise<unknown>;
}

/** A REST `GET` on a resource path, with the name URL-encoded. */
function getResource(
  client: DoctorWorkspaceClient,
  basePath: string,
  name: string,
): Promise<unknown> {
  return client.request({
    method: "GET",
    path: `${basePath}/${encodeURIComponent(name)}`,
  });
}

type ExistenceProbe = (
  client: DoctorWorkspaceClient,
  target: ResourceTarget,
) => Promise<LayerResult>;

// Read the HTTP status / Databricks error code off an ApiError structurally.
// Two shapes reach here: the wrapper's `ApiError` (from `request()`:
// `statusCode` / `errorCode`) and the modular SDK's (`httpStatusCode` / `code`).
function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { statusCode?: unknown; httpStatusCode?: unknown };
  const code = e.statusCode ?? e.httpStatusCode;
  return typeof code === "number" && code >= 0 ? code : undefined;
}

function errorCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { errorCode?: unknown; code?: unknown };
  const code = e.errorCode ?? e.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

// The SDK message often embeds a JSON blob; pull the inner `message` out so
// doctor prints one clean line, not a dump.
function cleanMessage(err: unknown): string {
  const raw = errorMessage(err);
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : raw;
}

/** The resource's configured identifier (id / name / path / host), for short
 * messages. */
function displayId(target: ResourceTarget): string | null {
  return field(target, "id", "name", "path", "index_name", "indexName", "host");
}

function classifyError(err: unknown, target: ResourceTarget): LayerResult {
  const status = statusCodeOf(err);
  const errorCode = errorCodeOf(err);
  const message = cleanMessage(err);
  const id = displayId(target);
  const quoted = id ? `"${id}"` : null;

  if (status === 404 || errorCode === "RESOURCE_DOES_NOT_EXIST") {
    return {
      layer: "existence",
      status: "error",
      code: "NOT_FOUND",
      detail: quoted ? `${quoted} not found` : "not found",
    };
  }
  // A malformed id/name often comes back as 400 rather than 404.
  if (status === 400 || errorCode === "INVALID_PARAMETER_VALUE") {
    return {
      layer: "existence",
      status: "error",
      code: "INVALID_VALUE",
      detail: quoted
        ? `${quoted} is not a valid id/name`
        : `invalid id/name: ${message}`,
    };
  }
  // A 403 is genuinely ambiguous: several APIs (jobs, warehouses) return it for a
  // resource that doesn't exist as well as for one you can't read, so claiming
  // "no permission" outright would misdiagnose a wrong id. Say both.
  if (status === 403 || errorCode === "PERMISSION_DENIED") {
    return {
      layer: "existence",
      status: "error",
      code: "ACCESS_DENIED",
      detail: quoted
        ? `${quoted} not found, or you don't have access to it`
        : "not found, or you don't have access to it",
    };
  }
  return {
    layer: "existence",
    status: "error",
    code: "PROBE_FAILED",
    detail: quoted
      ? `read failed for ${quoted}: ${message}`
      : `read failed: ${message}`,
  };
}

/** Normalizes a field key so camelCase (`indexName`) and snake_case
 * (`index_name`) spellings match. */
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
    detail: `no ${fieldName} configured — can't probe`,
  };
}

const probeWarehouse: ExistenceProbe = async (client, target) => {
  const id = field(target, "id");
  if (!id) return missingField("id");
  try {
    const wh = await client.warehouses.getWarehouse({ id });
    const state = wh.state;
    if (state && state !== "RUNNING") {
      return {
        layer: "existence",
        status: "warn",
        code: "WAREHOUSE_NOT_RUNNING",
        detail: `warehouse exists but is ${state} (will cold-start on first query)`,
      };
    }
    return EXISTENCE_OK;
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeServing: ExistenceProbe = async (client, target) => {
  const name = field(target, "name");
  // The API only accepts a name; if configured by id, probe with it anyway and
  // flag the likely cause on failure.
  const idOnly = name === null ? field(target, "id") : null;
  const value = name ?? idOnly;
  if (!value) return missingField("name");
  try {
    await getResource(client, "/api/2.0/serving-endpoints", value);
    return EXISTENCE_OK;
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
    await client.genie.genieGetSpace({ spaceId });
    return EXISTENCE_OK;
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeJob: ExistenceProbe = async (client, target) => {
  const raw = field(target, "id");
  if (!raw) return missingField("id");
  const id = raw.trim();
  // Validate the digits directly rather than via Number(): job ids are int64, so
  // past 2^53 Number() silently rounds (and Number.isInteger still passes),
  // which would probe a *different* job and report a false not-found. A string
  // check also rejects "1e3" and "0x10", both of which Number() would accept.
  if (!/^\d+$/.test(id)) {
    return {
      layer: "existence",
      status: "error",
      code: "INVALID_ID",
      detail: `"${raw}" is not a valid job id (expected an integer)`,
    };
  }
  try {
    // BigInt keeps int64 precision (the digits were validated above).
    await client.jobs.getJob({ jobId: BigInt(id) });
    return EXISTENCE_OK;
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
      detail: `"${raw}" is not a valid volume path (expected /Volumes/catalog/schema/volume or catalog.schema.volume)`,
    };
  }
  try {
    await getResource(client, "/api/2.1/unity-catalog/volumes", name);
    return EXISTENCE_OK;
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeVectorIndex: ExistenceProbe = async (client, target) => {
  const name = field(target, "indexName", "index_name", "name");
  if (!name) return missingField("indexName");
  try {
    await client.vectorSearch.getVectorIndex({ name });
    return EXISTENCE_OK;
  } catch (err) {
    return classifyError(err, target);
  }
};

const probeFunction: ExistenceProbe = async (client, target) => {
  const name = field(target, "name");
  if (!name) return missingField("name");
  try {
    await getResource(client, "/api/2.1/unity-catalog/functions", name);
    return EXISTENCE_OK;
  } catch (err) {
    return classifyError(err, target);
  }
};

function lakebaseAuthHint(message: string): string | undefined {
  if (/password authentication failed/i.test(message)) {
    return (
      "Lakebase uses an OAuth token as the password, so this usually means the" +
      " PGUSER/role doesn't match your identity. Check PGUSER is your exact" +
      " login."
    );
  }
  return undefined;
}

// Lakebase has no cheap control-plane `.get()`, so existence is proven by a
// real connection + `SELECT 1`.
const probePostgres: ExistenceProbe = async (client, target) => {
  if (!field(target, "endpointPath") && !field(target, "host")) {
    return missingField("host/endpoint");
  }

  let pool: LakebasePoolHandle | null = null;
  try {
    pool = await getLakebasePool(client);
    await pool.query("SELECT 1");
    return EXISTENCE_OK;
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

// Unlisted types fall through to NOT_IMPLEMENTED in runExistenceProbe.
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
