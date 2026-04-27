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
  id: string;
  /** `true` when the caller is the service principal (direct SDK call, not `asUser`). */
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
