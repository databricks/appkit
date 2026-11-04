/**
 * Calls the workspace's managed Omnigent server (`/api/2.0/omnigent`) with
 * the signed-in user's token, so sessions, Sandbox hosts and model calls are
 * the user's own.
 */
export class ManagedOmnigent {
  constructor(private readonly host: () => Promise<string>) {}

  async request(
    token: string,
    method: string,
    path: string,
    init: {
      json?: unknown;
      body?: RequestInit["body"];
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const r = await fetch(`${await this.host()}/api/2.0/omnigent${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: init.signal,
      redirect: "manual",
    });
    if (r.status === 403) {
      const text = await r.clone().text();
      if (text.includes("required scopes: all-apis")) {
        throw new OmnigentScopeError();
      }
    }
    return r;
  }
}

/**
 * Managed Omnigent only accepts tokens with the `all-apis` scope, which a
 * Databricks App's user authorization cannot request itself.
 */
export class OmnigentScopeError extends Error {
  readonly status = 403;
  constructor() {
    super(
      "Omnigent needs this app's user token to carry the all-apis scope. " +
        "An account admin adds it to the app's OAuth integration: " +
        "databricks account custom-app-integration update <app oauth2_app_integration_id> " +
        "with the app's current scopes plus all-apis. It can take up to an hour to reach users' tokens.",
    );
  }
}
