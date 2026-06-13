import type { ComponentType, SVGProps } from "react";
import { cn } from "../../lib/utils";

type IconColor =
  | "default"
  | "muted"
  | "primary"
  | "danger"
  | "warning"
  | "success";

type DbIconComponent = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    ariaLabel?: string;
  }
>;

interface DbIconProps {
  /** Icon component (DuBois SVG or compatible). */
  icon: DbIconComponent;
  /** Pixel size; defaults to DuBois standard 16. */
  size?: number;
  color?: IconColor;
  className?: string;
  /** When set, the icon gets `role="img"` and is announced. */
  ariaLabel?: string;
}

const colorMap: Record<IconColor, string> = {
  default: "",
  muted: "text-muted-foreground",
  primary: "text-primary",
  danger: "text-destructive",
  warning: "text-[var(--warning)]",
  success: "text-[var(--success)]",
};

/**
 * DuBois icon wrapper. Standardises sizing, semantic colour tokens,
 * and accessibility for the icon set vendored under `./*-icon.tsx`.
 */
export function DbIcon({
  icon: Icon,
  size = 16,
  color = "default",
  className,
  ariaLabel,
}: DbIconProps) {
  return (
    <Icon
      width={size}
      height={size}
      className={cn("shrink-0", colorMap[color], className)}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      aria-hidden={!ariaLabel}
    />
  );
}
