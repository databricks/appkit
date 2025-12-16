import { useEffect, useState } from "react";
import databricksLogo from "@/assets/databricks-logo.svg";
import databricksLogoWhite from "@/assets/databricks-logo-white.svg";

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const root = document.documentElement;
    // Check if dark class is explicitly set
    if (root.classList.contains("dark")) return true;
    if (root.classList.contains("light")) return false;
    // Fallback to system preference
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;

    const checkTheme = () => {
      if (root.classList.contains("dark")) {
        setIsDark(true);
      } else if (root.classList.contains("light")) {
        setIsDark(false);
      } else {
        // No explicit class, use system preference
        setIsDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
      }
    };

    // Check initial theme
    checkTheme();

    // Observe changes to the classList
    const observer = new MutationObserver(checkTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Also listen to system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = () => {
      // Only update if no explicit class is set
      if (
        !root.classList.contains("dark") &&
        !root.classList.contains("light")
      ) {
        setIsDark(mediaQuery.matches);
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleMediaChange);
      return () => {
        observer.disconnect();
        mediaQuery.removeEventListener("change", handleMediaChange);
      };
    } else {
      mediaQuery.addListener(handleMediaChange);
      return () => {
        observer.disconnect();
        mediaQuery.removeListener(handleMediaChange);
      };
    }
  }, []);

  return isDark;
}

export function DatabricksLogo() {
  const isDark = useDarkMode();
  const logoSrc = isDark ? databricksLogoWhite : databricksLogo;

  return (
    <img
      src={logoSrc}
      alt="Databricks"
      className="h-6 w-auto"
      aria-label="Databricks"
    />
  );
}
