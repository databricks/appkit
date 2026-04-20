import { createApp{{range $name, $_ := .plugins}}, {{$name}}{{end}} } from '@databricks/appkit';
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
