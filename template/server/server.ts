import { createApp{{range $name, $_ := .plugins}}, {{$name}}{{end}} } from '@databricks/appkit';
{{- if .plugins.lakebase}}
import { setupSampleLakebaseRoutes } from './routes/lakebase/todo-routes';
{{- end}}

createApp({
  plugins: [
{{- if .plugins.lakebase}}
    server({ autoStart: false }),
{{- range $name, $_ := .plugins}}
{{- if and (ne $name "server") (ne $name "sidecar")}}
    {{$name}}(),
{{- end}}
{{- end}}
{{- else}}
{{- range $name, $_ := .plugins}}
{{- if ne $name "sidecar"}}
    {{$name}}(),
{{- end}}
{{- end}}
{{- end}}
{{- if .plugins.sidecar}}
    sidecar({
      sidecars: [{
        id: 'sidecar',
        command: 'python3',
        args: ['main.py'],
        cwd: './sidecar',
      }],
    }),
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
