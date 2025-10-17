import type {
  IAuthManager,
  AuthConfig,
  UserAuthConfig,
  OAuthConfig,
  OAuth,
} from "@databricks-apps/types";

type ValidatedConfig = UserAuthConfig | OAuthConfig;

export class AuthManager implements IAuthManager {
  private cachedOauthToken?: OAuthToken;
  private clientId?: string;
  private clientSecret?: string;
  private host?: string;
  private devToken?: string;

  constructor() {
    this.clientId = process.env.DATABRICKS_CLIENT_ID;
    this.clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    this.host = process.env.DATABRICKS_HOST;
    this.devToken = process.env.DEV_TOKEN;
  }

  async getAuthToken(config?: Partial<AuthConfig>): Promise<string> {
    if (this.devToken) {
      return this.devToken;
    }

    const mergedConfig: AuthConfig = {
      host: config?.host || this.host,
      ...config,
    };

    const validatedConfig = this.validateAndApplyDefaults(mergedConfig);

    if (validatedConfig.authType === "user") {
      return this.getUserToken(validatedConfig);
    }

    if (validatedConfig.authType === "oauth") {
      return this.getOauthToken(validatedConfig);
    }

    throw new Error(
      "No authentication method available. Please provide either OAuth credentials or a user token.",
    );
  }

  private async getOauthToken(config: OAuthConfig): Promise<string> {
    if (
      this.cachedOauthToken &&
      this.cachedOauthToken.scopes === config.scope &&
      !this.cachedOauthToken.hasExpired
    ) {
      return this.cachedOauthToken.accessToken;
    }

    const oauthToken = await this.mintOauthToken(config);

    if (oauthToken) {
      this.cachedOauthToken = oauthToken;

      return oauthToken.accessToken;
    }

    if (config.token) {
      return config.token;
    }

    throw new Error(
      "Failed to obtain OAuth token. Please check your credentials.",
    );
  }

  private async getUserToken(config: UserAuthConfig): Promise<string> {
    if (!config.userToken) {
      throw new Error(
        "No user token provided. User authentication requires a valid token.",
      );
    }
    return config.userToken;
  }

  private validateAndApplyDefaults(config: AuthConfig): ValidatedConfig {
    if ("userToken" in config && config.userToken) {
      return {
        ...config,
        authType: "user",
        userToken: config.userToken,
      } as UserAuthConfig;
    }

    const clientId = (config as OAuth).clientId || this.clientId;
    const clientSecret = (config as OAuth).clientSecret || this.clientSecret;

    if (!clientId || !clientSecret) {
      if (config.token) {
        return {
          ...config,
          authType: "oauth",
          clientId: "",
          clientSecret: "",
          scope: "all-apis",
        } as OAuthConfig;
      }

      throw new Error(
        "No authentication credentials available. Please provide OAuth credentials (client_id/client_secret) or a token.",
      );
    }

    return {
      ...config,
      authType: "oauth",
      clientId,
      clientSecret,
      scope: (config as OAuth).scope || "all-apis",
    } as OAuthConfig;
  }

  private async mintOauthToken(
    config: OAuthConfig,
  ): Promise<OAuthToken | null> {
    try {
      const { clientId, clientSecret, scope } = config;
      let host = config.host || this.host;

      if (!clientId || !clientSecret || !host) {
        return null;
      }

      if (!host.startsWith("https://")) {
        host = `https://${host}`;
      }

      const url = `${host}/oidc/v1/token`;
      const params = new URLSearchParams();
      params.set("grant_type", "client_credentials");
      params.set("scope", scope || "all-apis");

      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      );

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `OAuth token request failed: ${response.status} - ${errorText}`,
        );
        return null;
      }

      const json = (await response.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };

      return (
        new OAuthToken(json.access_token, json.expires_in, scope?.split(" ")) ||
        null
      );
    } catch (error) {
      console.error("Error minting OAuth token:", error);
      return null;
    }
  }

  protected clearAuthCache(): void {
    this.cachedOauthToken = undefined;
  }
}

type OAuthScopes = Array<string>;

export default class OAuthToken {
  private readonly _accessToken: string;

  private readonly _scopes?: OAuthScopes;

  private readonly _expirationTime: number;

  constructor(accessToken: string, expiresIn: number, scopes?: OAuthScopes) {
    this._accessToken = accessToken;
    this._scopes = scopes;
    this._expirationTime = Math.floor(Date.now() / 1000) + expiresIn;
  }

  get accessToken(): string {
    return this._accessToken;
  }

  get scopes(): string | undefined {
    return this._scopes?.toString();
  }

  get expirationTime(): number {
    return this._expirationTime;
  }

  get hasExpired(): boolean {
    const now = Math.floor(Date.now() / 1000);

    return this.expirationTime <= now;
  }
}
