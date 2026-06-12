#!/usr/bin/env bash
#
# SessionStart hook: prepare a fresh git worktree so it is ready to run.
#
# Runs `pnpm install` + `pnpm run build` the first time a Claude Code session
# opens inside a linked worktree that has no node_modules yet. It is a no-op in
# the primary checkout and in worktrees that are already set up, so it is safe
# to run on every session start.
#
# The .env files are copied separately by .worktreeinclude (repo root) at
# worktree-creation time; this hook only handles dependency install + build,
# which .worktreeinclude cannot do.
#
# Registered in .claude/settings.json under hooks.SessionStart.

# Anchor to the worktree this session is running in.
toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

# The parent of the shared git common dir is the primary worktree. Normalize to
# an absolute path so the comparison works whether common_dir is "." (primary)
# or an absolute path (linked worktree).
main_worktree=$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd) || exit 0

# Only act inside a linked worktree, never the primary checkout.
[ "$toplevel" = "$main_worktree" ] && exit 0

# Already set up — nothing to do (keeps this cheap on resume/clear/compact).
[ -d "$toplevel/node_modules" ] && exit 0

echo "setup-worktree: fresh worktree at $toplevel — running pnpm install + build…" >&2
cd "$toplevel" || exit 0

# Ensure pnpm is available (the repo manages it via corepack).
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm >/dev/null 2>&1 || true
fi

# Best-effort: report failures on stderr but never block session startup. If a
# step fails, re-run `pnpm install && pnpm run build` manually in the worktree.
if ! pnpm install >&2; then
  echo "setup-worktree: pnpm install failed — run it manually in $toplevel" >&2
  exit 0
fi
if ! pnpm run build >&2; then
  echo "setup-worktree: pnpm run build failed — run it manually in $toplevel" >&2
  exit 0
fi

echo "setup-worktree: worktree ready." >&2
exit 0
