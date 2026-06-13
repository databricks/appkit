/**
 * Per-volume file access policies.
 *
 * A `FilePolicy` is a function that decides whether a given action on a
 * resource is allowed for a specific user. When a policy is attached to a
 * volume, the policy controls whether the action is allowed for the requesting user.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Every action the files plugin can perform. */
export type FileAction =
  | "list"
  | "read"
  | "download"
  | "raw"
  | "exists"
  | "metadata"
  | "preview"
  | "upload"
  | "mkdir"
  | "delete";

/** Actions that only read data. */
export const READ_ACTIONS: ReadonlySet<FileAction> = new Set<FileAction>([
  "list",
  "read",
  "download",
  "raw",
  "exists",
  "metadata",
  "preview",
]);

/** Actions that mutate data. */
export const WRITE_ACTIONS: ReadonlySet<FileAction> = new Set<FileAction>([
  "upload",
  "mkdir",
  "delete",
]);

// ---------------------------------------------------------------------------
// Resource & User
// ---------------------------------------------------------------------------

/** Describes the file or directory being acted upon. */
export interface FileResource {
  /** Relative path within the volume. */
  path: string;
  /** The volume key (e.g. `"uploads"`). */
  volume: string;
  /** Content length in bytes — only present for uploads. */
  size?: number;
}

/** Minimal user identity passed to the policy function. */
export interface FilePolicyUser {
  /**
   * Identifier of the requesting caller. For end-user HTTP requests this is
   * the value of the `x-forwarded-user` header; for direct SDK calls and
   * header-less HTTP requests (which run as the service principal), this is
   * the service principal's ID.
   */
  id: string;
  /**
   * `true` when the call is executing as the service principal — either a
   * direct SDK call (`appKit.files(...)`) or an HTTP request that arrived
   * without an `x-forwarded-user` / `x-forwarded-access-token` header.
   * Policy authors typically check this first to distinguish SP traffic
   * from end-user traffic.
   *
   * The flag reflects the **policy user** the plugin selects, which
   * combines the volume's effective `auth` mode with the headers on the
   * incoming request. The full matrix:
   *
   * | Volume `auth`         | Path                           | Headers                       | `isServicePrincipal` | Notes                                                                                          |
   * | --------------------- | ------------------------------ | ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
   * | `service-principal`   | HTTP                           | `x-forwarded-user` present    | `false` (or unset)   | Pre-OBO behavior. Policy sees the end user but the SDK call still runs as the SP.              |
   * | `service-principal`   | HTTP                           | no `x-forwarded-user`         | `true`               | Headerless request — policy and SDK both run as the SP.                                        |
   * | `on-behalf-of-user`   | HTTP                           | valid token + user header     | `false`              | Real end-user execution. Policy sees the user; the SDK call also runs as the user.             |
   * | `on-behalf-of-user`   | HTTP                           | missing token, dev-fallback   | `true`               | Only reachable when `NODE_ENV === "development"` (prod returns 401). Treated as SP traffic.    |
   * | any                   | Programmatic `asUser(req)`     | `x-forwarded-user` present    | `false`              | `asUser` extracts the user; the SDK call runs as the user inside `runInUserContext`.           |
   *
   * Programmatic calls without `asUser(req)` always set
   * `isServicePrincipal: true` because no request is available to derive a
   * user identity from. OBO volume defaults apply only to HTTP route
   * traffic; for programmatic per-user execution, use `asUser(req)`.
   */
  isServicePrincipal?: boolean;
}

// ---------------------------------------------------------------------------
// Policy function type
// ---------------------------------------------------------------------------

/**
 * A policy function that decides whether `user` may perform `action` on
 * `resource`. Return `true` to allow, `false` to deny.
 */
export type FilePolicy = (
  action: FileAction,
  resource: FileResource,
  user: FilePolicyUser,
) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// PolicyDeniedError
// ---------------------------------------------------------------------------

/**
 * Thrown when a policy denies an action.
 */
export class PolicyDeniedError extends Error {
  readonly action: FileAction;
  readonly volumeKey: string;

  constructor(action: FileAction, volumeKey: string) {
    super(`Policy denied "${action}" on volume "${volumeKey}"`);
    this.name = "PolicyDeniedError";
    this.action = action;
    this.volumeKey = volumeKey;
  }
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Utility namespace with common policy combinators. */
export const policy = {
  /**
   * AND — all policies must allow. Short-circuits on first denial.
   */
  all(...policies: FilePolicy[]): FilePolicy {
    if (policies.length === 0) {
      throw new Error("policy.all() requires at least one policy");
    }
    return async (action, resource, user) => {
      for (const p of policies) {
        if (!(await p(action, resource, user))) return false;
      }
      return true;
    };
  },

  /**
   * OR — at least one policy must allow. Short-circuits on first allow.
   */
  any(...policies: FilePolicy[]): FilePolicy {
    if (policies.length === 0) {
      throw new Error("policy.any() requires at least one policy");
    }
    return async (action, resource, user) => {
      for (const p of policies) {
        if (await p(action, resource, user)) return true;
      }
      return false;
    };
  },

  /** Negates a policy. */
  not(p: FilePolicy): FilePolicy {
    return async (action, resource, user) => !(await p(action, resource, user));
  },

  /** Allow all read actions (list, read, download, raw, exists, metadata, preview). */
  publicRead(): FilePolicy {
    return (action) => READ_ACTIONS.has(action);
  },

  /** Deny every action. */
  denyAll(): FilePolicy {
    return () => false;
  },

  /** Allow every action. */
  allowAll(): FilePolicy {
    return () => true;
  },
} as const;
