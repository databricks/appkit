import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credentials a session's agent bundle carries to call the app's MCP endpoint.
 *
 * The key is `HMAC(secret, nonce + "\n" + user)`, so the plugin can verify a
 * tool call after a restart without storing anything: it recomputes the HMAC
 * from the headers. A key only ever stands for the user it was minted for.
 */
interface SessionKey {
  user: string;
  nonce: string;
  key: string;
}

export const MCP_USER_HEADER = "x-omnigent-user";
const MCP_NONCE_HEADER = "x-omnigent-nonce";
export const MCP_KEY_HEADER = "x-omnigent-key";

export class SessionKeys {
  private readonly secret: string;

  /**
   * @param secret Stable across restarts (the app's OAuth client secret in
   *   Apps). Without one, keys are only valid for the life of the process.
   */
  constructor(secret?: string) {
    this.secret = secret || randomBytes(32).toString("hex");
  }

  mint(user: string): SessionKey {
    const nonce = randomBytes(18).toString("base64url");
    return { user, nonce, key: this.sign(nonce, user) };
  }

  /** Returns the user a request's key stands for, or `null`. */
  verify(
    headers: Record<string, string | string[] | undefined>,
  ): string | null {
    const user = first(headers[MCP_USER_HEADER]);
    const nonce = first(headers[MCP_NONCE_HEADER]);
    const key = first(headers[MCP_KEY_HEADER]);
    if (!user || !nonce || !key) return null;
    const expected = Buffer.from(this.sign(nonce, user));
    const given = Buffer.from(key);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    return user;
  }

  headers(k: SessionKey): Record<string, string> {
    return {
      [MCP_USER_HEADER]: k.user,
      [MCP_NONCE_HEADER]: k.nonce,
      [MCP_KEY_HEADER]: k.key,
    };
  }

  private sign(nonce: string, user: string): string {
    return createHmac("sha256", this.secret)
      .update(`${nonce}\n${user.toLowerCase()}`)
      .digest("base64url");
  }
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
