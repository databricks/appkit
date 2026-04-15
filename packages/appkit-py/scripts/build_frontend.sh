#!/usr/bin/env bash
# Build the bundled frontend and place output in src/appkit_py/static/
#
# This is run at release time (not by end users). It requires Node.js and pnpm.
# The built assets are included in the Python wheel via pyproject.toml package-data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
FRONTEND_DIR="$PACKAGE_DIR/frontend"
OUTPUT_DIR="$PACKAGE_DIR/src/appkit_py/static"

echo "==> Building appkit-ui (dependency)..."
cd "$REPO_ROOT"
pnpm --filter=appkit-ui build:package

echo "==> Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm install

echo "==> Building frontend (output: $OUTPUT_DIR)..."
npm run build

echo "==> Frontend build complete. Assets in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"
