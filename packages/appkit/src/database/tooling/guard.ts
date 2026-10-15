import type { DbContext } from "./context";
import { currentIdentity } from "./identity";
import type { LakebaseBranch } from "./lakebase-api";
import { devBranchId, sessionBranchId } from "./naming";
import {
  parseResourceName,
  readDeployBranches,
  readLocalTarget,
  resourceId,
} from "./targets";

// Commands that write to a branch run only on branches `appkit db init`
// created for this developer (dev-…) or this checkout (session-…).

interface BranchVerdict {
  readonly appkitOwned: boolean;
  /** Why the branch is not AppKit-owned. */
  readonly reason?: string;
}

export function classifyBranch(input: {
  branch: LakebaseBranch;
  userName: string;
  sessionId: string | null;
  /** Every branch databricks.yml deploys to; the deployed app migrates those itself. */
  deployBranches: readonly string[];
}): BranchVerdict {
  const { branch, userName, sessionId, deployBranches } = input;
  if (branch.status?.default) {
    return { appkitOwned: false, reason: "it is the project's default branch" };
  }
  if (branch.status?.is_protected) {
    return { appkitOwned: false, reason: "it is a protected branch" };
  }
  if (deployBranches.includes(branch.name)) {
    return {
      appkitOwned: false,
      reason: "it is a branch databricks.yml deploys to",
    };
  }
  const id = resourceId(branch.name);
  if (id === devBranchId(userName)) return { appkitOwned: true };
  if (sessionId && id === sessionBranchId(sessionId)) {
    return { appkitOwned: true };
  }
  return {
    appkitOwned: false,
    reason: `it is not your dev branch (${devBranchId(userName)})${
      sessionId
        ? ` or this checkout's session branch (${sessionBranchId(sessionId)})`
        : ""
    }`,
  };
}

interface BranchCheck {
  readonly branch: LakebaseBranch;
  readonly verdict: BranchVerdict;
}

/** Classify the `.env` branch through the API (no database connection); null when none is configured. */
export async function checkAppkitBranch(
  ctx: DbContext,
): Promise<BranchCheck | null> {
  const local = readLocalTarget(ctx.env);
  const name = parseResourceName(local.endpoint ?? undefined)?.branch;
  if (!name) return null;
  const branch = await ctx.api().getBranch(name);
  if (!branch) {
    throw new Error(
      `The .env branch ${name} does not exist (deleted or expired). Run \`appkit db init\` to create or pick one.`,
    );
  }
  const { userName } = await currentIdentity(ctx);
  return {
    branch,
    verdict: classifyBranch({
      branch,
      userName,
      sessionId: local.session,
      deployBranches: readDeployBranches(ctx.root),
    }),
  };
}
