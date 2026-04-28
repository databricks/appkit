import { createApp{{range $name, $p := .plugins}}{{if ne $p.Stability "beta"}}, {{$name}}{{end}}{{end}} } from '@databricks/appkit';
{{- range $name, $p := .plugins}}
{{- if eq $p.Stability "beta"}}
import { {{$name}} } from '@databricks/appkit/beta';
{{- end}}
{{- end}}
{{- if .plugins.lakebase}}
import { setupSampleLakebaseRoutes } from './routes/lakebase/todo-routes';
{{- end}}

createApp({
  plugins: [
{{- range $name, $_ := .plugins}}
    {{$name}}(),
{{- end}}
  ],
{{- if .plugins.lakebase}}
  async onPluginsReady(appkit) {
    await setupSampleLakebaseRoutes(appkit);
  },
{{- end}}
}).catch(console.error);
