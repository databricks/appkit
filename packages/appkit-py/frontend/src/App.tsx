import { getClientConfig } from "@databricks/appkit-ui/js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import {
  createBrowserRouter,
  NavLink,
  Outlet,
  RouterProvider,
} from "react-router";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { FilesPage } from "./pages/FilesPage";
import { GeniePage } from "./pages/GeniePage";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground"
  }`;

const PLUGIN_PAGES: Record<
  string,
  { label: string; path: string; element: React.ReactNode }
> = {
  analytics: {
    label: "Analytics",
    path: "/analytics",
    element: <AnalyticsPage />,
  },
  files: { label: "Files", path: "/files", element: <FilesPage /> },
  genie: { label: "Genie", path: "/genie", element: <GeniePage /> },
};

function Layout() {
  const config = getClientConfig();
  const enabledPlugins = Object.keys(config.endpoints).filter(
    (name) => name !== "server" && name in PLUGIN_PAGES,
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">
          {config.appName || "AppKit"}
        </h1>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Home
          </NavLink>
          {enabledPlugins.map((name) => (
            <NavLink
              key={name}
              to={PLUGIN_PAGES[name].path}
              className={navLinkClass}
            >
              {PLUGIN_PAGES[name].label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}

function buildRouter() {
  const config = getClientConfig();
  const enabledPlugins = Object.keys(config.endpoints).filter(
    (name) => name !== "server" && name in PLUGIN_PAGES,
  );

  return createBrowserRouter([
    {
      element: <Layout />,
      children: [
        { path: "/", element: <HomePage /> },
        ...enabledPlugins.map((name) => ({
          path: PLUGIN_PAGES[name].path,
          element: PLUGIN_PAGES[name].element,
        })),
      ],
    },
  ]);
}

export default function App() {
  return <RouterProvider router={buildRouter()} />;
}

function HomePage() {
  const config = getClientConfig();
  const enabledPlugins = Object.keys(config.endpoints).filter(
    (name) => name !== "server",
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 mt-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-2 text-foreground">
          Welcome to {config.appName || "your Databricks App"}
        </h2>
        <p className="text-lg text-muted-foreground">
          Powered by Databricks AppKit (Python)
        </p>
      </div>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle>Getting Started</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Your app is running with {enabledPlugins.length} plugin
            {enabledPlugins.length !== 1 ? "s" : ""} enabled
            {enabledPlugins.length > 0 && <>: {enabledPlugins.join(", ")}</>}.
          </p>
          <ul className="space-y-2 text-sm">
            <li>
              <a
                href="https://github.com/databricks/appkit"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
              >
                AppKit on GitHub
              </a>
            </li>
            <li>
              <a
                href="https://databricks.github.io/appkit/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
              >
                AppKit documentation
              </a>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
