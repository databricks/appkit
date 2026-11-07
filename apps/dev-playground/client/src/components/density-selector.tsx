import { Button } from "@databricks/appkit-ui/react";
import { Rows3Icon, Rows4Icon } from "lucide-react";
import { useState } from "react";

type Density = "comfortable" | "compact";

const DENSITY_STORAGE_KEY = "appkit-playground-density";

function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  return localStorage.getItem(DENSITY_STORAGE_KEY) === "compact"
    ? "compact"
    : "comfortable";
}

/**
 * Toggles appkit-ui's spacing density. It's set on <html> so portaled
 * overlays (dialogs, menus) follow it; index.html applies the stored value
 * before first paint.
 */
export function DensitySelector() {
  const [density, setDensity] = useState<Density>(() => getStoredDensity());

  const toggle = () => {
    const next = density === "compact" ? "comfortable" : "compact";
    setDensity(next);
    localStorage.setItem(DENSITY_STORAGE_KEY, next);
    document.documentElement.dataset.density = next;
  };

  const label =
    density === "compact"
      ? "Switch to comfortable spacing"
      : "Switch to compact spacing";

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-foreground hover:text-secondary-foreground"
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      {density === "compact" ? (
        <Rows4Icon className="h-4 w-4" />
      ) : (
        <Rows3Icon className="h-4 w-4" />
      )}
    </Button>
  );
}
