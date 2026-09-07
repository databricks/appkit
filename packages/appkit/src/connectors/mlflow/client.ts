/** Shared client for talking to the Databricks/MLflow REST API. */

/** Ensure the host has a scheme (Databricks env often lacks `https://`). */
export function normalizeHost(raw: string): string {
  const h = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

/** Structured result for a best-effort POST that must not throw. */
export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * A thin client over the Databricks workspace REST API, owning the host + bearer
 * token so callers (eval-run creation, assessment writes, the judge's serving
 * endpoint) don't each re-derive URLs or re-attach auth. The host is normalized
 * once at construction.
 */
export class MlflowClient {
  /** Normalized workspace base URL (scheme guaranteed, no trailing slash). */
  readonly baseUrl: string;
  private readonly token: string;

  constructor(host: string, token: string) {
    this.baseUrl = normalizeHost(host);
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
  }

  /**
   * POST JSON to an MLflow REST endpoint. Returns the parsed JSON body, or
   * throws with the status + response text so callers can surface a precise
   * error. Use for calls whose failure should abort (e.g. `runs/create`).
   *
   * The thrown message embeds up to 500 chars of the upstream response body to
   * aid debugging. That is fine for the dev-facing eval CLI, but do NOT relay
   * it into an end-user HTTP response if this client is reused in a request
   * handler — the body can carry workspace-internal detail.
   */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} -> ${res.status} ${text.slice(0, 500)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * POST JSON without throwing: returns `{ ok, status, error }` so best-effort
   * writes (e.g. per-trace assessments) can be collected and reported without
   * aborting the run.
   *
   * `error` embeds up to 500 chars of the upstream body — same caveat as
   * {@link post}: fine to log for the dev CLI, don't relay it to end users.
   */
  async postResult(path: string, body: unknown): Promise<PostResult> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, error: text.slice(0, 500) };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * OpenAI-compatible base URL for Databricks Model Serving, used as the judge's
   * `OPENAI_BASE_URL`. Same workspace host + token as the MLflow REST calls.
   */
  servingEndpointsUrl(): string {
    return `${this.baseUrl}/serving-endpoints`;
  }
}
