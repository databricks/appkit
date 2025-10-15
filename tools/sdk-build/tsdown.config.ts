import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: 'packages/backend/index.ts',
    outDir: 'dist/@databricks/apps',
    platform: 'node',
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    entry: 'packages/frontend/index.ts',
    outDir: 'dist/@databricks/apps/react',
    platform: 'browser',
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
  },
])