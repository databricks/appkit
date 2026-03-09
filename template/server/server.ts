import { createApp{{range $name, $_ := .plugins}}, {{$name}}{{end}} } from '@databricks/appkit';
{{- if .plugins.lakebase}}
import { setupSampleLakebaseRoutes } from './routes/lakebase/todo-routes';
{{- end}}

createApp({
  plugins: [
{{- if .plugins.lakebase}}
    server({ autoStart: false }),
{{- range $name, $_ := .plugins}}
{{- if ne $name "server"}}
    {{$name}}(),
{{- end}}
{{- end}}
{{- else}}
{{- range $name, $_ := .plugins}}
    {{$name}}(),
{{- end}}
{{- end}}
  ],
})
{{- if .plugins.lakebase}}
  .then(async (appkit) => {
    await setupSampleLakebaseRoutes(appkit);
    await appkit.server.start();
  })
{{- end}}
  .catch(console.error);
