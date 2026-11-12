{{if and .plugins.analytics (not .skipExamples) -}}
-- @param message STRING
SELECT :message AS value;
{{- end}}
