import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.databricks/**'],
    server: {
      deps: {
        // Transform appkit-ui and echarts-for-react instead of letting Node
        // load them: echarts-for-react's ESM build uses extensionless
        // imports, which Node's ESM loader rejects, so a test importing an
        // appkit-ui chart would fail to load.
        inline: [/@databricks\/appkit-ui/, 'echarts-for-react'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});
