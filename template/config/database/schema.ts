{{if .plugins.database -}}
import { defineSchema } from '@databricks/appkit/beta';

// database() discovers this file automatically. Edit tables here, then run
// `npx appkit db migrate` on your dev branch. The deployed app's service principal
// owns schema "app" and applies committed migrations on start.
export const schema = defineSchema(() => ({}));
{{- end}}
