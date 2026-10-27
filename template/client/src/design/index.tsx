{{if .plugins.design -}}
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

/*
 * The design page, shown full size at /design (dev only). Build the layout here
 * with AppKit components; add more pages as client/src/design/pages/<name>.tsx,
 * served at /design/<name>. Each file's default export is the page.
 */
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
