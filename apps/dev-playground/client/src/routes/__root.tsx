import {
  CatchBoundary,
  createRootRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { ErrorComponent } from "@/components/error-component";
import { Button, TooltipProvider } from "@databricks/app-kit-ui/react";
import { ThemeSelector } from "@/components/theme-selector";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";

  return (
    <TooltipProvider>
      {!isHomePage && (
        <div className="border-b border-gray-200 bg-background px-6 py-4 sticky top-0 z-10 shadow-sm">
          <div className="max-w-7xl mx-auto">
            <nav className="flex items-center justify-between gap-4">
              <Link
                to="/"
                className="no-underline text-inherit hover:opacity-80 transition-opacity"
              >
                <h4 className="text-xl font-semibold tracking-tight text-foreground">
                  App Kit Playground
                </h4>
              </Link>
              <div className="flex items-center gap-3">
                <Link to="/analytics" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-foreground hover:text-secondary-foreground"
                  >
                    Analytics
                  </Button>
                </Link>
                <Link to="/arrow-analytics" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-foreground hover:text-secondary-foreground"
                  >
                    Arrow Analytics
                  </Button>
                </Link>
                <Link to="/reconnect" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-foreground hover:text-secondary-foreground"
                  >
                    Reconnect
                  </Button>
                </Link>
                <Link to="/telemetry" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-foreground hover:text-secondary-foreground"
                  >
                    Telemetry
                  </Button>
                </Link>
                <Link to="/sql-helpers" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-foreground hover:text-secondary-foreground"
                  >
                    SQL Helpers
                  </Button>
                </Link>
                <ThemeSelector />
              </div>
            </nav>
          </div>
        </div>
      )}
      <CatchBoundary
        getResetKey={() => location.pathname}
        onCatch={(error) => {
          console.error(error);
        }}
        errorComponent={(error) => <ErrorComponent error={error} />}
      >
        <Outlet />
      </CatchBoundary>
    </TooltipProvider>
  );
}
