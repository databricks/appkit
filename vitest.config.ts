import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'frontend',
          root: './packages/frontend',
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'backend',
          root: './packages/backend',
          environment: 'node',
        },
      },
    ],
  },
})