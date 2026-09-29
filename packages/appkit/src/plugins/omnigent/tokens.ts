import type express from "express";

import { ServiceContext } from "../../context/service-context";
import type { UserContext } from "../../context/user-context";

/**
 * The latest forwarded token of each user, in memory only.
 *
 * Tool calls arrive from a harness, not from the user's browser, so they carry
 * no forwarded token. Each request the user makes to the app refreshes theirs
 * here, and a tool call runs with it. After a restart the map is empty until
 * the user's next request; a tool call before that fails with a clear error.
 */
export class UserTokens {
  private readonly byUser = new Map<
    string,
    { token: string; email?: string }
  >();

  /** Remembers the request's forwarded token for `user`. */
  remember(req: express.Request, user: string): void {
    const token = req.header("x-forwarded-access-token")?.trim();
    if (token)
      this.byUser.set(user, { token, email: req.header("x-forwarded-email") });
  }

  /**
   * An AppKit user context for running a tool as `user`. In development
   * without a forwarded token, `undefined`: the tool runs as the app, like
   * `asUser()` does there.
   */
  userContext(user: string): UserContext | undefined {
    const t = this.byUser.get(user);
    if (!t) {
      if (process.env.NODE_ENV === "development") return undefined;
      throw new Error(
        "No current sign-in for this session's user. Open the app again to continue.",
      );
    }
    return ServiceContext.createUserContext(t.token, user, undefined, t.email);
  }
}
