const LAKEBASE_MAX_BRANCH_ID_LENGTH = 63;
const DEV_PREFIX = "dev-";
const SESSION_PREFIX = "session-";
const USER_HASH_HEX_LENGTH = 6;
const SESSION_ID_LENGTH =
  LAKEBASE_MAX_BRANCH_ID_LENGTH -
  SESSION_PREFIX.length -
  USER_HASH_HEX_LENGTH -
  1;

const DEVELOPMENT_BRANCH_SHAPES = {
  dev: new RegExp(
    `^${DEV_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{${USER_HASH_HEX_LENGTH}}$`,
  ),
  session: new RegExp(
    `^${SESSION_PREFIX}[0-9a-f]{${USER_HASH_HEX_LENGTH}}-[a-z0-9]{1,${SESSION_ID_LENGTH}}$`,
  ),
} as const;

export type DevelopmentBranchKind = keyof typeof DEVELOPMENT_BRANCH_SHAPES;

export function developmentBranchKind(
  branchId: string,
): DevelopmentBranchKind | undefined {
  if (branchId.length > LAKEBASE_MAX_BRANCH_ID_LENGTH) return undefined;
  return (
    Object.keys(DEVELOPMENT_BRANCH_SHAPES) as DevelopmentBranchKind[]
  ).find((kind) => DEVELOPMENT_BRANCH_SHAPES[kind].test(branchId));
}
