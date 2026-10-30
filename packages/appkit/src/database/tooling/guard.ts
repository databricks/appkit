import { type DbContext, hasEnvBranch, NO_ENV_BRANCH } from "./context";
import { currentIdentity } from "./identity";
import type { LakebaseBranch } from "./lakebase-api";
import { devBranchId, sessionBranchId } from "./naming";
import {
  type DeployBoundary,
  parseResourceName,
  readDeployBoundary,
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

/**
 * Why databricks.yml makes a branch one it deploys to; null when it does not.
 * A reference the files cannot resolve may name any branch, so it refuses all;
 * everyBranchRefusal names the references.
 */
export function deployRefusal(
  boundary: DeployBoundary,
  branch: string,
): string | null {
  if (boundary.unresolved.length > 0) {
    return "databricks.yml may deploy to it through a reference this checkout's files do not resolve";
  }
  return boundary.branches.has(branch)
    ? "it is a branch databricks.yml deploys to"
    : null;
}

/**
 * While databricks.yml has a reference this checkout's files cannot resolve,
 * any branch may be one it deploys to: `migrate` applies migrations to no
 * branch, and `init`, `introspect`, `clean` and `seed` refuse every branch.
 * This says so, names the references and where to give them values; null when
 * every reference resolves.
 */
export function everyBranchRefusal(boundary: DeployBoundary): string | null {
  if (boundary.unresolved.length === 0) return null;
  const references = boundary.unresolved
    .map(
      ({ target, at, written, file }) =>
        `${at} in target ${target}${file ? ` with ${file}` : ""} (${written ? JSON.stringify(written) : "no value"})`,
    )
    .join(", ");
  const where = boundary.unresolved.some(({ file }) => file)
    ? "databricks.yml or the variable-overrides.json named"
    : "databricks.yml";
  return `The files do not resolve ${references}, so \`appkit db migrate\` applies migrations to no branch, and \`init\`, \`introspect\`, \`clean\` and \`seed\` refuse every branch. Give ${boundary.unresolved.length > 1 ? "them values" : "it a value"} in ${where}`;
}

/**
 * Why a command writes nothing to a branch: `why`, then `advice` when it
 * applies. While every branch is refused (see everyBranchRefusal), advice that
 * leads to `appkit db init` or another branch cannot help, so the text names
 * the references to resolve instead.
 */
export function writeRefusal(
  why: string,
  boundary: DeployBoundary,
  advice?: string,
): string {
  const next = everyBranchRefusal(boundary) ?? advice;
  return next ? `${why}. ${next}` : why;
}

export function classifyBranch(input: {
  branch: LakebaseBranch;
  userName: string;
  sessionId: string | null;
  /** What databricks.yml deploys to; the deployed app migrates those branches itself. */
  boundary: DeployBoundary;
}): Classification {
  const { branch, userName, sessionId, boundary } = input;
  if (branch.status?.default) {
    return { kind: "default", reason: "it is the project's default branch" };
  }
  if (branch.status?.is_protected) {
    return { kind: "protected", reason: "it is a protected branch" };
  }
  const deployReason = deployRefusal(boundary, branch.name);
  if (deployReason) return { kind: "deploy-target", reason: deployReason };
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

/** The .env branch, what it is to this developer, and the boundary that decided it. */
interface EnvBranch extends Classification {
  readonly branch: LakebaseBranch;
  readonly boundary: DeployBoundary;
}

/** Why a command does not write to the .env branch, then `advice` when it applies (see writeRefusal). */
export function notYourBranch(env: EnvBranch, advice?: string): string {
  return writeRefusal(
    `${resourceId(env.branch.name)} is not your dev or session branch (${env.reason})`,
    env.boundary,
    advice,
  );
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
  const boundary = readDeployBoundary(ctx.root);
  const [branch, { userName }] = await Promise.all([
    ctx.api().getBranch(name),
    currentIdentity(ctx),
  ]);
  if (!branch) {
    throw new Error(
      `${writeRefusal(
        `The .env branch ${name} does not exist (deleted or expired)`,
        boundary,
        "Run `appkit db init` to create or pick one",
      )}.`,
    );
  }
  return {
    branch,
    boundary,
    ...classifyBranch({
      branch,
      userName,
      sessionId: local.session,
      boundary,
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
