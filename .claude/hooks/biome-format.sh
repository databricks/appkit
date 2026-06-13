#!/usr/bin/env bash
# PostToolUse hook: auto-format the edited file with Biome.
#
# Runs `biome check --write` on the single file Claude just edited so
# formatting and safe lint fixes apply deterministically after every edit,
# instead of relying on the advisory "run check:fix when done" workflow.
# Non-blocking by design: it never fails the turn (Biome's own ignore rules
# in biome.json keep generated files out), it just keeps the tree formatted.
set -euo pipefail

input=$(cat)

# Extract tool_input.file_path from the hook's stdin JSON (node is always
# available in this repo).
file=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch{process.stdout.write("")}})')

[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

# Only touch files Biome handles.
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR" || exit 0
pnpm exec biome check --write "$file" >/dev/null 2>&1 || true
exit 0
