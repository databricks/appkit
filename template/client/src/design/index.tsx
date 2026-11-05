{{if .plugins.design -}}
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

/*
 * /design (dev only); more pages go in pages/<name>.tsx (/design/<name>), linked
 * with <Link to="/<name>"> (router basename /design). Content that renders late:
 * useDesignReady(isDone) from '@databricks/appkit-ui/react/beta'.
 */

// Marks this starter page: /design isn't reported ready while it's exported. Delete it.
export const designPlaceholder = true;

export default function DesignPage() {
  return (
    <main className="min-h-screen bg-background p-6 md:p-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-foreground">{{.projectName}}</h1>
          <p className="text-muted-foreground">A starting point for your design.</p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Get started</CardTitle>
            <CardDescription>Replace this page with your layout.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button>Primary action</Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
{{- end}}
