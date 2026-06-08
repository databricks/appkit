{{if .plugins.analytics -}}
-- @param message STRING
SELECT :message AS value;
{{- end}}
