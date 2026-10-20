{{if .plugins.design -}}
import { Button, Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

/*
 * Every PascalCase export in this folder is rendered with no props on the
 * design canvas at /design (dev only). Put design-only drafts here, or
 * previews that render your real components with mock data.
 */
export function ExampleCard() {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Example draft</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Click Select, pick elements, add a note and send them to your agent.</p>
        <Button>Primary action</Button>
      </CardContent>
    </Card>
  );
}
{{- end}}
