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

type BranchKind =
  | "default"
  | "protected"
  | "deploy-target"
  | "dev"
  | "session"
  | "other";

interface Classification {
  readonly kind: BranchKind;
  readonly reason?: string;
}

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

export function everyBranchRefusal(boundary: DeployBoundary): string | null {
  if (boundary.unresolved.length === 0) return null;
  const references = boundary.unresolved
    .map(({ target, at, written, file, environment }) => {
      const values = [file, environment].filter(Boolean).join(" and ");
      return `${at} in target ${target}${values ? ` with ${values}` : ""} (${written ? JSON.stringify(written) : "no value"})`;
    })
    .join(", ");
  const where = [
    "databricks.yml",
    ...(boundary.unresolved.some(({ file }) => file)
      ? ["the variable-overrides.json named"]
      : []),
    ...(boundary.unresolved.some(({ environment }) => environment)
      ? ["the BUNDLE_VAR_ variable named"]
      : []),
  ].join(" or ");
  return `The files do not resolve ${references}, so \`appkit db migrate\` applies migrations to no branch, and \`init\`, \`introspect\`, \`clean\` and \`seed\` refuse every branch. Give ${boundary.unresolved.length > 1 ? "them values" : "it a value"} in ${where}`;
}

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

export function takesWrites(kind: BranchKind): boolean {
  return kind === "dev" || kind === "session";
}

interface EnvBranch extends Classification {
  readonly branch: LakebaseBranch;
  readonly boundary: DeployBoundary;
}

export function notYourBranch(env: EnvBranch, advice?: string): string {
  return writeRefusal(
    `${resourceId(env.branch.name)} is not your dev or session branch (${env.reason})`,
    env.boundary,
    advice,
  );
}

export async function resolveEnvBranch(
  ctx: DbContext,
): Promise<EnvBranch | null> {
  const local = readLocalTarget(ctx.env);
  const name = parseResourceName(local.endpoint ?? undefined)?.branch;
  if (!name || !hasEnvBranch(ctx.env)) return null;
  const boundary = readDeployBoundary(ctx.root, ctx.env);
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
