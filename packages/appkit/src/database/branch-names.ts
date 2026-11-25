// The branch ids `appkit db init` gives dev and session branches. Runtime
// code reads them to refuse a deploy bound to one, so they live outside
// tooling/, which runtime code may not import.

/** Lakebase's limit on a branch id. */
const MAX_BRANCH_ID = 63;
const DEV_PREFIX = "dev-";
const SESSION_PREFIX = "session-";
/** Hex characters of the user's name hash in both shapes. */
const HASH_LENGTH = 6;
/** The longest session id that keeps session-<hash6>-<id> within MAX_BRANCH_ID. */
const SESSION_ID_LENGTH =
  MAX_BRANCH_ID - SESSION_PREFIX.length - HASH_LENGTH - 1;

const DEVELOPMENT_BRANCH_SHAPES = {
  dev: new RegExp(
    `^${DEV_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{${HASH_LENGTH}}$`,
  ),
  session: new RegExp(
    `^${SESSION_PREFIX}[0-9a-f]{${HASH_LENGTH}}-[a-z0-9]{1,${SESSION_ID_LENGTH}}$`,
  ),
} as const;

export type DevelopmentBranchKind = keyof typeof DEVELOPMENT_BRANCH_SHAPES;

/**
 * Which kind of development branch the id has the exact shape of:
 * `dev-<user>-<hash6>` or `session-<hash6>-<id>`. undefined for any other id,
 * such as a deploy branch named `session-store`.
 */
export function developmentBranchKind(
  branchId: string,
): DevelopmentBranchKind | undefined {
  if (branchId.length > MAX_BRANCH_ID) return undefined;
  return (
    Object.keys(DEVELOPMENT_BRANCH_SHAPES) as DevelopmentBranchKind[]
  ).find((kind) => DEVELOPMENT_BRANCH_SHAPES[kind].test(branchId));
}
