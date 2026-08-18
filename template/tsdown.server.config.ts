import { defineConfig } from 'tsdown';

export default defineConfig({
  // server/agents/*/agent.ts aren't imported anywhere; list them as entries so the build emits dist/agents/*/agent.js for runtime discovery.
  entry: [{{if .plugins.agents}}'server/server.ts', 'server/agents/*/agent.ts'{{else}}'server/server.ts'{{end}}],
  unbundle: true,
  // Clear the out dir so a deleted agent can't linger in dist/agents/.
  clean: true,
  external: (id) => /^[^./]/.test(id) || id.includes('/node_modules/'),
  tsconfig: 'tsconfig.server.json',
  outExtensions: () => ({
    js: '.js',
  }),
});
