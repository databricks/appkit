import type { LakebasePoolConfig } from "@databricks/lakebase";

import { createLogger } from "../../logging/logger";

const logger = createLogger("connectors:lakebase");

/** The lookup is advisory, so it never holds startup longer than this. */
const HOST_CHECK_TIMEOUT_MS = 3_000;
const MAX_REASON_LENGTH = 240;
const ENDPOINT_NAME = /^projects\/[^/]+\/branches\/[^/]+\/endpoints\/[^/]+$/;

/** One lookup per endpoint and host, shared by every pool that asks. */
const checks = new Map<string, Promise<void>>();

type HostCheckConfig = Pick<
  Partial<LakebasePoolConfig>,
  "endpoint" | "host" | "workspaceClient"
>;

/**
 * Warn when PGHOST is not a host of LAKEBASE_ENDPOINT. Tokens are issued for
 * the endpoint but the pool connects to the host, so a stale PGHOST quietly
 * serves another branch's database and its tables. The check never fails
 * startup: an endpoint that cannot be read only skips it.
 */
export function warnOnEndpointHostMismatch(
  config: HostCheckConfig,
): Promise<void> {
  const endpoint = config.endpoint ?? process.env.LAKEBASE_ENDPOINT;
  const host = config.host ?? process.env.PGHOST;
  const client = config.workspaceClient;
  if (!endpoint || !host || !client || !ENDPOINT_NAME.test(endpoint)) {
    return Promise.resolve();
  }
  const key = `${endpoint}\n${host.toLowerCase()}`;
  let check = checks.get(key);
  if (!check) {
    check = compareHosts(client, endpoint, host);
    checks.set(key, check);
  }
  return check;
}

async function compareHosts(
  client: NonNullable<HostCheckConfig["workspaceClient"]>,
  endpoint: string,
  host: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      client.apiClient.request({
        path: `/api/2.0/postgres/${endpoint}`,
        method: "GET",
        headers: new Headers({ Accept: "application/json" }),
        raw: false,
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), HOST_CHECK_TIMEOUT_MS);
      }),
    ]);
    const hosts = endpointHosts(response);
    if (hosts.length === 0) {
      logger.debug("Skipped the PGHOST check: %s listed no hosts", endpoint);
      return;
    }
    if (hosts.includes(host.toLowerCase())) return;
    logger.warn(
      "PGHOST %s is not a host of LAKEBASE_ENDPOINT %s (expected %s). Credentials are issued for the endpoint, but queries run against whichever database PGHOST serves. Set PGHOST to the endpoint's host.",
      host,
      endpoint,
      hosts.join(" or "),
    );
  } catch (error) {
    // SDK errors embed the whole response body; its message comes first.
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_REASON_LENGTH);
    // An endpoint that no longer exists is itself the misconfiguration.
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    ) {
      logger.warn(
        "LAKEBASE_ENDPOINT %s was not found (%s). Check the project, branch, and endpoint names; `databricks postgres list-endpoints projects/{project}/branches/{branch}` lists them with their hosts.",
        endpoint,
        reason,
      );
      return;
    }
    logger.debug("Skipped the PGHOST check for %s: %s", endpoint, reason);
  } finally {
    clearTimeout(timer);
  }
}

/** Read every host the endpoint serves, read-write and read-only. */
function endpointHosts(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const status = Reflect.get(response, "status");
  if (!status || typeof status !== "object") return [];
  const hosts = Reflect.get(status, "hosts");
  if (!hosts || typeof hosts !== "object") return [];
  return Object.values(hosts)
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .map((value) => value.toLowerCase());
}
