import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TooltipProvider,
} from "@databricks/appkit-ui/react";
import {
  CatchBoundary,
  createRootRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { MenuIcon } from "lucide-react";
import { ErrorComponent } from "@/components/error-component";
import { ThemeSelector } from "@/components/theme-selector";
import { findNavItemForPath, NAV_GROUPS } from "@/lib/nav";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const location = useLocation();
  const navigate = useNavigate();
  const isHomePage = location.pathname === "/";

  const currentPage = findNavItemForPath(location.pathname);

  return (
    <TooltipProvider>
      {!isHomePage && (
        <div className="border-b border-gray-200 bg-background px-6 py-4 sticky top-0 z-10 shadow-sm">
          <div className="max-w-7xl mx-auto">
            <nav className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <Link
                  to="/"
                  className="no-underline text-inherit hover:opacity-80 transition-opacity shrink-0"
                >
                  <h4 className="text-xl font-semibold tracking-tight text-foreground">
                    AppKit Playground
                  </h4>
                </Link>
                {currentPage && (
                  <>
                    <span
                      className="text-muted-foreground shrink-0"
                      aria-hidden
                    >
                      /
                    </span>
                    <span className="text-sm font-medium text-foreground truncate">
                      {currentPage.label}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="text-foreground hover:text-secondary-foreground gap-2"
                      aria-label="Open navigation menu"
                    >
                      <MenuIcon className="h-4 w-4" />
                      <span>Menu</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-56 max-h-[calc(100vh-5rem)] overflow-y-auto"
                  >
                    {NAV_GROUPS.map((group, groupIdx) => (
                      <DropdownMenuGroup key={group.id}>
                        {groupIdx > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wide">
                          {group.label}
                        </DropdownMenuLabel>
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          const isActive = location.pathname.startsWith(
                            item.to,
                          );
                          return (
                            <DropdownMenuItem
                              key={item.to}
                              onSelect={() => {
                                void navigate({ to: item.to });
                              }}
                              className={
                                isActive
                                  ? "bg-accent text-accent-foreground font-medium"
                                  : ""
                              }
                            >
                              <Icon className="h-4 w-4 mr-2 text-muted-foreground" />
                              {item.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuGroup>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
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
