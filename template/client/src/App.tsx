import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';
{{- if .plugins.analytics}}
import { AnalyticsPage } from './pages/analytics/AnalyticsPage';
{{- end}}
{{- if .plugins.lakebase}}
import { LakebasePage } from './pages/lakebase/LakebasePage';
{{- end}}
{{- if .plugins.genie}}
import { GeniePage } from './pages/genie/GeniePage';
{{- end}}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

function Layout() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">{{.projectName}}</h1>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Home
          </NavLink>
{{- if .plugins.analytics}}
          <NavLink to="/analytics" className={navLinkClass}>
            Analytics
          </NavLink>
{{- end}}
{{- if .plugins.lakebase}}
          <NavLink to="/lakebase" className={navLinkClass}>
            Lakebase
          </NavLink>
{{- end}}
{{- if .plugins.genie}}
          <NavLink to="/genie" className={navLinkClass}>
            Genie
          </NavLink>
{{- end}}
        </nav>
      </header>

      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
{{- if .plugins.analytics}}
      { path: '/analytics', element: <AnalyticsPage /> },
{{- end}}
{{- if .plugins.lakebase}}
      { path: '/lakebase', element: <LakebasePage /> },
{{- end}}
{{- if .plugins.genie}}
      { path: '/genie', element: <GeniePage /> },
{{- end}}
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

function HomePage() {
  return (
    <div className="max-w-2xl mx-auto space-y-6 mt-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-2 text-foreground">
          Welcome to your Databricks App
        </h2>
        <p className="text-lg text-muted-foreground">
          Powered by Databricks AppKit
        </p>
      </div>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle>Getting Started</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Your app is ready. Explore the resources below to continue building.</p>
          <ul className="space-y-2 text-sm">
            <li>
              <a
                href="https://github.com/databricks/appkit"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
              >
                AppKit on GitHub →
              </a>
            </li>
            <li>
              <a
                href="https://databricks.github.io/appkit/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
              >
                AppKit documentation →
              </a>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
