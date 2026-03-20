import type { TokenProvider, SearchError } from './types';

export class ServicePrincipalTokenProvider implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private host: string;

  constructor(host: string) {
    this.host = host;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 120_000) {
      return this.token;
    }

    const response = await fetch(`https://${this.host}/oidc/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.DATABRICKS_CLIENT_ID!,
        client_secret: process.env.DATABRICKS_CLIENT_SECRET!,
        scope: 'all-apis',
      }).toString(),
    });

    const data = await response.json();
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.token!;
  }
}

export class OboTokenExtractor {
  static extractFromRequest(req: { headers: Record<string, string | undefined> }): string {
    const token = req.headers['x-forwarded-access-token'];
    if (!token) {
      const error: SearchError = {
        code: 'UNAUTHORIZED',
        message: 'No user token found. Ensure app is configured for user authorization.',
        statusCode: 401,
      };
      throw error;
    }
    return token;
  }
}
