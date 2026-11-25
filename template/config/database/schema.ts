{{if .plugins.database -}}
import { defineSchema } from '@databricks/appkit/beta';

// database() discovers this file automatically. It starts with no tables:
// add declarations here after creating the corresponding PostgreSQL tables.
export const schema = defineSchema(() => ({}));
{{- end}}
