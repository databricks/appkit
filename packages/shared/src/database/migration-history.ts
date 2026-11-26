/**
 * The recovery for a migration history that cannot run in order after main's.
 * The migration out of order is often main's own, so deleting it is never the
 * fix.
 */
export const MIGRATION_HISTORY_REWRITE =
  "Save any SQL you wrote by hand in your migration, such as a backfill. Merge main, reset config/database/migrations to main's (for example `git restore --source main --staged --worktree config/database/migrations`), then run `appkit db clean` and `appkit db migrate`, which writes your schema change again after main's migrations. Add the saved SQL back to the migration it writes and review it before you commit.";
