import { defineConfig } from 'tsdown';

export default defineConfig({
{{- if .plugins.agents}}
  // server/agents/*/agent.ts aren't imported anywhere; list them as entries so the build emits dist/agents/*/agent.js for runtime discovery.
  entry: ['server/server.ts', 'server/agents/*/agent.ts'],
  // Clear the out dir so a deleted agent can't linger in dist/agents/.
  clean: true,
{{- else}}
  entry: 'server/server.ts',
{{- end}}
  unbundle: true,
  external: (id) => /^[^./]/.test(id) || id.includes('/node_modules/'),
  tsconfig: 'tsconfig.server.json',
  outExtensions: () => ({
    js: '.js',
  }),
});
