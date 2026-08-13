{{- $betaImports := "" -}}
{{- range $name, $p := .plugins -}}
  {{- if eq $p.Stability "beta" -}}
    {{- if eq $betaImports "" -}}
      {{- $betaImports = $name -}}
    {{- else -}}
      {{- $betaImports = printf "%s, %s" $betaImports $name -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
import { createApp{{range $name, $p := .plugins}}{{if ne $p.Stability "beta"}}, {{$name}}{{end}}{{end}} } from '@databricks/appkit';
{{- if ne $betaImports "" }}
import { {{$betaImports}} } from '@databricks/appkit/beta';
{{- end}}
{{- if .plugins.lakebase}}
import { setupSampleLakebaseRoutes } from './routes/lakebase/todo-routes';
{{- end}}
{{- if .plugins.agents}}
import { helper } from './agents/helper';
{{- end}}

export const app = createApp({
{{- if .plugins.agents}}
  // Uses AppKit's existing TelemetryManager / OTel provider. The setup
  // command provisions the immutable UC trace location before first run.
  telemetry: { mlflowUc: true },
{{- end}}
  plugins: [
{{- range $name, $_ := .plugins}}
{{- if eq $name "agents"}}
    agents({
      defaultModel: process.env.DATABRICKS_AGENT_SERVING_ENDPOINT_NAME,
      agents: { helper },
    }),
{{- else}}
    {{$name}}(),
{{- end}}
{{- end}}
  ],
{{- if .plugins.lakebase}}
  async onPluginsReady(appkit) {
    await setupSampleLakebaseRoutes(appkit);
  },
{{- end}}
});

app.catch(console.error);
