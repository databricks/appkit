import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
{{- if .plugins.serving}}
import { appKitServingTypesPlugin } from '@databricks/appkit';
{{- end}}

// https://vite.dev/config/
export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    tailwindcss(),
{{- if .plugins.serving}}
    appKitServingTypesPlugin(),
{{- end}}
  ],
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'recharts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
