# AppKit UI Examples

These demo components are derived from `shadcn/ui` v3, specifically [`apps/v4/components`](https://github.com/shadcn-ui/ui/tree/v3/apps/v4/components).

Run `pnpm exec tsx tools/sync-appkit-examples.ts` from the repo root to re-sync the `.example.tsx` files and the generated `examples/index.ts` map.

The sync script copies each example next to its matching UI component, rewrites internal `@/` imports to relative paths, and rebuilds the example registry consumed by `DocExample`.

