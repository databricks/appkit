import type { LakebasePoolConfig } from "@databricks/lakebase";

import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { contextFromAbortSignal } from "../context";

const logger = createLogger("connectors:lakebase");

/** An unavailable lookup must not delay startup indefinitely. */
const HOST_CHECK_TIMEOUT_MS = 3_000;
const ENDPOINT_NAME =
  /^projects\/[A-Za-z0-9._-]+\/branches\/[A-Za-z0-9._-]+\/endpoints\/[A-Za-z0-9._-]+$/;
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Share in-flight lookups only between pools using the same workspace identity. */
type Client = NonNullable<LakebasePoolConfig["workspaceClient"]>;
const checks = new WeakMap<Client, Map<string, Promise<void>>>();

type HostCheckConfig = Pick<
  Partial<LakebasePoolConfig>,
  "endpoint" | "host" | "workspaceClient" | "password"
>;

/**
 * Refuse a confirmed OAuth host mismatch before the pool can access another branch.
 * An endpoint that cannot be read is not proof of a mismatch, so it skips the
 * check without blocking startup.
 */
export function assertEndpointHostMatches(
  config: HostCheckConfig,
): Promise<void> {
  const endpoint = config.endpoint ?? process.env.LAKEBASE_ENDPOINT;
  const host = config.host ?? process.env.PGHOST;
  const client = config.workspaceClient;
  if (
    !endpoint ||
    !host ||
    !client ||
    config.password !== undefined ||
    !ENDPOINT_NAME.test(endpoint) ||
    !HOST_NAME.test(host)
  ) {
    return Promise.resolve();
  }
  const key = `${endpoint}\n${host.toLowerCase()}`;
  let clientChecks = checks.get(client);
  if (!clientChecks) {
    clientChecks = new Map();
    checks.set(client, clientChecks);
  }
  let check = clientChecks.get(key);
  if (!check) {
    check = compareHosts(client, endpoint, host).finally(() => {
      clientChecks.delete(key);
    });
    clientChecks.set(key, check);
  }
  return check;
}

async function compareHosts(
  client: NonNullable<HostCheckConfig["workspaceClient"]>,
  endpoint: string,
  host: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let hosts: string[];
  const warnUnverified = (reason: string) =>
    logger.warn(
      "Could not verify PGHOST %s against LAKEBASE_ENDPOINT %s (%s). Check the endpoint host manually before using this pool.",
      host,
      endpoint,
      reason,
    );
  try {
    const response = await Promise.race([
      client.apiClient.request(
        {
          path: `/api/2.0/postgres/${endpoint}`,
          method: "GET",
          headers: new Headers({ Accept: "application/json" }),
          raw: false,
        },
        contextFromAbortSignal(controller.signal),
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, HOST_CHECK_TIMEOUT_MS);
      }),
    ]);
    hosts = endpointHosts(response);
  } catch (error) {
    // An endpoint that no longer exists is itself the misconfiguration.
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    ) {
      logger.warn(
        "LAKEBASE_ENDPOINT %s was not found. Check the project, branch, and endpoint names; `databricks postgres list-endpoints projects/{project}/branches/{branch}` lists them with their hosts.",
        endpoint,
      );
      return;
    }
    warnUnverified(
      controller.signal.aborted ? "lookup timed out" : "lookup failed",
    );
    return;
  } finally {
    clearTimeout(timer);
  }
  if (hosts.length === 0) {
    warnUnverified(
      controller.signal.aborted
        ? "lookup timed out"
        : "endpoint returned no hosts",
    );
    return;
  }
  if (hosts.includes(host.toLowerCase())) return;
  logger.error(
    "PGHOST %s is not a host of LAKEBASE_ENDPOINT %s (expected %s). Refusing to connect to the wrong branch.",
    host,
    endpoint,
    hosts.join(" or "),
  );
  throw new ConfigurationError(
    `PGHOST ${host} is not a host of LAKEBASE_ENDPOINT ${endpoint} (expected ${hosts.join(" or ")}). Set PGHOST to a host of the configured endpoint before starting the app.`,
  );
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
      (value): value is string =>
        typeof value === "string" && HOST_NAME.test(value),
    )
    .map((value) => value.toLowerCase());
}
