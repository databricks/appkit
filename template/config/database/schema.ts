{{if .plugins.database -}}
import { defineSchema } from '@databricks/appkit/beta';

// database() discovers this file automatically. Start with no exposed tables.
// Add declarations here after creating the corresponding PostgreSQL tables.
export const schema = defineSchema(() => ({}));
{{- end}}
