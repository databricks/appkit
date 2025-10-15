export type AuthMethodOptions = {
  userToken?: string;
};

interface BaseAuthConfig {
  host?: string;
  token?: string;
}

interface UserAuth extends BaseAuthConfig {
  userToken: string;
}

export interface OAuth extends BaseAuthConfig {
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export interface UserAuthConfig extends UserAuth {
  authType: "user";
}

export interface OAuthConfig extends OAuth {
  authType: "oauth";
}

export type AuthConfig = { host?: string } & (
  | Partial<UserAuthConfig>
  | Partial<OAuthConfig>
);

export interface IAuthManager {
  getAuthToken(config?: Partial<AuthConfig>): Promise<string>;
}
