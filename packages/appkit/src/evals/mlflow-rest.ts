/** Shared helpers for talking to the Databricks/MLflow REST API. */

export interface MlflowRestOptions {
  /** Databricks workspace host (scheme optional — normalized). */
  host: string;
  /** Bearer token for the MLflow REST API. */
  token: string;
}

/** Ensure the host has a scheme (Databricks env often lacks `https://`). */
export function normalizeHost(raw: string): string {
  const h = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

/**
 * POST JSON to an MLflow REST endpoint. Returns the parsed JSON body, or throws
 * with the status + response text so callers can surface a precise error.
 */
export async function mlflowPost<T = unknown>(
  options: MlflowRestOptions,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${normalizeHost(options.host)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 500)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
