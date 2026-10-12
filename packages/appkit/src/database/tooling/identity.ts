import type { DbContext } from "./context";
import type { IdentityType } from "./lakebase-api";

/** Who runs the command: the Postgres role name is the user name (email or SP client ID). */
export interface Identity {
  readonly userName: string;
  readonly identityType: IdentityType;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A service principal's user name is its application (client) ID. */
export function identityTypeOf(userName: string): IdentityType {
  return UUID.test(userName) ? "SERVICE_PRINCIPAL" : "USER";
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
        return { userName, identityType: identityTypeOf(userName) };
      });
    identity.catch(() => identities.delete(ctx));
    identities.set(ctx, identity);
  }
  return identity;
}
