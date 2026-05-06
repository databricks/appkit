#!/usr/bin/env bash
#
# Scans commits between $BASE_SHA and $HEAD_SHA for Conventional Commits
# breaking-change markers, restricted to the packages tracked by
# .release-it.json. Writes `found` and (on match) `list` to $GITHUB_OUTPUT.
#
# Required env: BASE_SHA, HEAD_SHA, GITHUB_OUTPUT

set -euo pipefail

PATHS=(packages/appkit packages/appkit-ui packages/shared)

# Conventional Commits breaking-change markers:
#   1. `type!:` or `type(scope)!:` in the subject line
#   2. `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer line
PATTERN='^(feat|fix|chore|refactor|perf|build|ci|docs|style|test|revert)(\([^)]+\))?!:|^BREAKING[ -]CHANGE:'

breaking=""
while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  msg=$(git log -1 --format=%B "$sha")
  if printf '%s\n' "$msg" | grep -Eq "$PATTERN"; then
    subject=$(git log -1 --format=%s "$sha")
    breaking+="- \`${sha:0:7}\` ${subject}"$'\n'
  fi
done < <(git rev-list "$BASE_SHA".."$HEAD_SHA" -- "${PATHS[@]}")

if [ -n "$breaking" ]; then
  {
    echo "found=true"
    echo "list<<COMMITS_EOF"
    printf '%s' "$breaking"
    echo "COMMITS_EOF"
  } >> "$GITHUB_OUTPUT"
  echo "Breaking commits found:"
  printf '%s' "$breaking"
else
  echo "found=false" >> "$GITHUB_OUTPUT"
  echo "No breaking commits found."
fi
