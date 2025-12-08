import {
  CatchBoundary,
  createRootRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { ErrorComponent } from "@/components/error-component";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";

  return (
    <TooltipProvider>
      {!isHomePage && (
        <div className="border-b border-gray-200 bg-white px-6 py-4 sticky top-0 z-10 shadow-sm">
          <div className="max-w-7xl mx-auto">
            <nav className="flex items-center justify-between gap-4">
              <Link
                to="/"
                className="no-underline text-inherit hover:opacity-80 transition-opacity"
              >
                <h4 className="text-xl font-semibold tracking-tight">
                  App Kit Playground
                </h4>
              </Link>
              <div className="flex gap-3">
                <Link to="/analytics" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-gray-700 hover:text-gray-900"
                  >
                    Analytics
                  </Button>
                </Link>
                <Link to="/reconnect" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-gray-700 hover:text-gray-900"
                  >
                    Reconnect
                  </Button>
                </Link>
                <Link to="/telemetry" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-gray-700 hover:text-gray-900"
                  >
                    Telemetry
                  </Button>
                </Link>
                <Link to="/sql-helpers" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-gray-700 hover:text-gray-900"
                  >
                    SQL Helpers
                  </Button>
                </Link>
                <Link to="/type-safety" className="no-underline">
                  <Button
                    variant="ghost"
                    className="text-gray-700 hover:text-gray-900"
                  >
                    Type Safety
                  </Button>
                </Link>
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
