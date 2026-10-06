function need(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required (see e2e/identity/README.md)`);
  return value;
}

/** The signed-in user the forwarded token belongs to. */
export const USER_EMAIL = need("E2E_USER_EMAIL");
const USER_TOKEN = need("E2E_USER_TOKEN");

/**
 * With an SP secret the server runs as that SP. Without one (local mode) it runs
 * on the user's own token, so SP and user are the same principal and the tests
 * that compare them skip with this reason instead of passing for nothing.
 */
export const DISTINCT_SP = Boolean(process.env.E2E_SP_CLIENT_SECRET);
export const NEEDS_DISTINCT_SP =
  "needs a distinct SP (set E2E_SP_CLIENT_ID and E2E_SP_CLIENT_SECRET)";

/** The app service principal the server runs as; `current_user()` returns its client id. */
export const SP_CLIENT_ID = DISTINCT_SP ? need("E2E_SP_CLIENT_ID") : "";
/** What `current_user()` returns for a call that ran on the server's own credentials. */
export const SERVER_IDENTITY = DISTINCT_SP ? SP_CLIENT_ID : USER_EMAIL;

/** The headers the Databricks Apps proxy forwards for a signed-in user. */
export const userHeaders = {
  "x-forwarded-access-token": USER_TOKEN,
  "x-forwarded-user": USER_EMAIL,
  "x-forwarded-email": USER_EMAIL,
};

export const appEnv = {
  // Not "development": dev mode turns a missing user token into a silent SP run.
  NODE_ENV: "production",
  DATABRICKS_APP_PORT: "{port}",
  DATABRICKS_HOST: need("DATABRICKS_HOST"),
  ...(DISTINCT_SP
    ? {
        DATABRICKS_CLIENT_ID: SP_CLIENT_ID,
        DATABRICKS_CLIENT_SECRET: need("E2E_SP_CLIENT_SECRET"),
      }
    : { DATABRICKS_TOKEN: USER_TOKEN }),
  DATABRICKS_WAREHOUSE_ID: need("DATABRICKS_WAREHOUSE_ID"),
  DATABRICKS_SERVING_ENDPOINT_NAME: need("DATABRICKS_SERVING_ENDPOINT_NAME"),
  LAKEBASE_ENDPOINT: need("LAKEBASE_ENDPOINT"),
  PGHOST: need("PGHOST"),
  PGDATABASE: need("PGDATABASE"),
  PGPORT: process.env.PGPORT ?? "5432",
  PGSSLMODE: process.env.PGSSLMODE ?? "require",
};

export type SseEvent = { event: string; data: any };

/** POST a JSON body and collect every SSE event the route streams. */
export async function postSse(
  url: URL,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; events: SseEvent[]; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (data === undefined) continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data });
    }
  }
  return { status: res.status, events, text };
}

/** `current_user()` from an analytics query stream, or undefined when it errored. */
export function identityFromQuery(events: SseEvent[]): string | undefined {
  return events.find((e) => e.data?.type === "result")?.data.data?.[0]
    ?.identity;
}
