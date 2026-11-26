{{if .plugins.database -}}
import { defineSchema } from '@databricks/appkit/beta';

export const schema = defineSchema(() => ({}));
{{- end}}
