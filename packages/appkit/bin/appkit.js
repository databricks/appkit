#!/usr/bin/env node

// In-source shim so `npx @databricks/appkit …` resolves to the real CLI when
// consuming this package from the monorepo (node_modules/@databricks/appkit is
// a pnpm workspace symlink to packages/appkit, so no published tarball ever
// runs). The npm spec requires `bin` paths to live inside the package, so we
// can't point `bin` directly at packages/shared/bin/appkit.js — this file
// exists solely to delegate.
//
// The published npm package is unaffected: tools/dist-appkit.ts overwrites
// this file with packages/shared/bin/appkit.js and copies the bundled CLI
// into ./dist/cli/, so end consumers run the same code from a self-contained
// tarball.
import "../../shared/bin/appkit.js";
