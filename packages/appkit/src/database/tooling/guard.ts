import { type DbContext, hasEnvBranch, NO_ENV_BRANCH } from "./context";
import { currentIdentity } from "./identity";
import type { LakebaseBranch } from "./lakebase-api";
import { devBranchId, sessionBranchId } from "./naming";
import {
  parseResourceName,
  readDeployBranches,
  readLocalTarget,
  resourceId,
} from "./targets";

/** What a branch is to this developer, checked in this order. */
type BranchKind =
  | "default"
  | "protected"
  | "deploy-target"
  | "dev"
  | "session"
  | "other";

interface Classification {
  readonly kind: BranchKind;
  /** Why the branch takes no writes; undefined for dev and session branches. */
  readonly reason?: string;
}

export function classifyBranch(input: {
  branch: LakebaseBranch;
  userName: string;
  sessionId: string | null;
  /** Every branch databricks.yml deploys to; the deployed app migrates those itself. */
  deployBranches: readonly string[];
}): Classification {
  const { branch, userName, sessionId, deployBranches } = input;
  if (branch.status?.default) {
    return { kind: "default", reason: "it is the project's default branch" };
  }
  if (branch.status?.is_protected) {
    return { kind: "protected", reason: "it is a protected branch" };
  }
  if (deployBranches.includes(branch.name)) {
    return {
      kind: "deploy-target",
      reason: "it is a branch databricks.yml deploys to",
    };
  }
  const id = resourceId(branch.name);
  if (id === devBranchId(userName)) return { kind: "dev" };
  const session = sessionId ? sessionBranchId(userName, sessionId) : null;
  if (id === session) return { kind: "session" };
  return {
    kind: "other",
    reason: `it is not your dev branch (${devBranchId(userName)})${
      session ? ` or this checkout's session branch (${session})` : ""
    }`,
  };
}

/**
 * Commands write only to branches `appkit db init` created for this developer
 * (dev-…) or this checkout (session-…).
 */
export function takesWrites(kind: BranchKind): boolean {
  return kind === "dev" || kind === "session";
}

/** The .env branch and what it is to this developer. */
interface EnvBranch extends Classification {
  readonly branch: LakebaseBranch;
}

/** Why a command does not write to the branch. */
export function notYourBranch(env: EnvBranch): string {
  return `${resourceId(env.branch.name)} is not your dev or session branch (${env.reason})`;
}

/**
 * Classify the .env branch through the API, without connecting. null when .env
 * does not name a branch to connect to (see NO_ENV_BRANCH).
 */
export async function resolveEnvBranch(
  ctx: DbContext,
): Promise<EnvBranch | null> {
  const local = readLocalTarget(ctx.env);
  const name = parseResourceName(local.endpoint ?? undefined)?.branch;
  if (!name || !hasEnvBranch(ctx.env)) return null;
  const [branch, { userName }] = await Promise.all([
    ctx.api().getBranch(name),
    currentIdentity(ctx),
  ]);
  if (!branch) {
    throw new Error(
      `The .env branch ${name} does not exist (deleted or expired). Run \`appkit db init\` to create or pick one.`,
    );
  }
  return {
    branch,
    ...classifyBranch({
      branch,
      userName,
      sessionId: local.session,
      deployBranches: readDeployBranches(ctx.root),
    }),
  };
}

/** The .env branch, for a command that only runs on your dev or session branch. */
export async function writableEnvBranch(
  ctx: DbContext,
  action: string,
): Promise<LakebaseBranch> {
  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not ${action}: ${NO_ENV_BRANCH}.`);
  if (!takesWrites(env.kind)) {
    throw new Error(`Refusing to ${action}: ${notYourBranch(env)}.`);
  }
  return env.branch;
}
