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
import { setupTodoRoutes } from './routes/lakebase/todo-routes';
import { ensureSchema, initDb } from './db';
{{- end}}
{{- if .plugins.agents}}
import { helper } from './agents/helper';
{{- end}}

createApp({
  plugins: [
{{- range $name, $_ := .plugins}}
{{- if eq $name "agents"}}
    agents({ agents: { helper } }),
{{- else}}
    {{$name}}(),
{{- end}}
{{- end}}
  ],
{{- if .plugins.lakebase}}
  async onPluginsReady(appkit) {
    try {
      await ensureSchema(appkit.lakebase.pool);
    } catch (err) {
      console.warn('[lakebase] Database setup failed:', (err as Error).message);
      console.warn('[lakebase] Routes will be registered but may return errors');
      console.warn('[lakebase] See https://www.databricks.com/devhub/docs/appkit/v0/plugins/lakebase#database-permissions for troubleshooting');
    }
    const db = await initDb(appkit);
    setupTodoRoutes(appkit, db);
  },
{{- end}}
}).catch(console.error);
