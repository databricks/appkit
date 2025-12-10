import { useEffect, useState } from "react";
import { MoonIcon, SunIcon, MonitorIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@databricks/app-kit-ui/react";
import { Button } from "@databricks/app-kit-ui/react";

type Theme = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "app-kit-playground-theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return (stored as Theme) || "system";
}

function applyTheme(theme: Theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  root.classList.remove("light", "dark");

  if (theme === "system") {
    const systemTheme = getSystemTheme();
    root.classList.add(systemTheme);
  } else {
    root.classList.add(theme);
  }
}

export function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [mounted, setMounted] = useState(false);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    getSystemTheme(),
  );

  useEffect(() => {
    setMounted(true);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const isDark = e.matches;
      setSystemTheme(isDark ? "dark" : "light");
      // Apply theme if current theme is "system"
      if (theme === "system") {
        applyTheme("system");
      }
    };

    // Set initial system theme
    handleChange(mediaQuery);

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, [theme]);

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    applyTheme(newTheme);
  };

  // Get current effective theme for icon display
  const effectiveTheme = theme === "system" ? systemTheme : theme;

  if (!mounted) {
    // Return a placeholder to avoid hydration mismatch
    return (
      <Button variant="ghost" size="icon" className="h-9 w-9">
        <SunIcon className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-foreground hover:text-secondary-foreground"
          aria-label="Toggle theme"
        >
          {effectiveTheme === "dark" ? (
            <MoonIcon className="h-4 w-4" />
          ) : (
            <SunIcon className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => handleThemeChange("light")}
          className="cursor-pointer"
        >
          <SunIcon className="mr-2 h-4 w-4" />
          <span>Light</span>
          {theme === "light" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleThemeChange("dark")}
          className="cursor-pointer"
        >
          <MoonIcon className="mr-2 h-4 w-4" />
          <span>Dark</span>
          {theme === "dark" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleThemeChange("system")}
          className="cursor-pointer"
        >
          <MonitorIcon className="mr-2 h-4 w-4" />
          <span>System</span>
          {theme === "system" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
