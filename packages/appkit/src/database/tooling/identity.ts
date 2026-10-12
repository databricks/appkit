import type { DbContext } from "./context";

/** Who runs the command: the Postgres role name is the user name (email or SP client ID). */
interface Identity {
  readonly userName: string;
}

const identities = new WeakMap<DbContext, Promise<Identity>>();

/** currentUser.me(), once per context. */
export function currentIdentity(ctx: DbContext): Promise<Identity> {
  let identity = identities.get(ctx);
  if (!identity) {
    identity = ctx
      .workspace()
      .currentUser.me()
      .then(({ userName }) => {
        if (!userName) {
          throw new Error(
            "Could not determine the current Databricks user (currentUser.me returned no userName). Check DATABRICKS_CONFIG_PROFILE.",
          );
        }
        return { userName };
      });
    identity.catch(() => identities.delete(ctx));
    identities.set(ctx, identity);
  }
  return identity;
}
