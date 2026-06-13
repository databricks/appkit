import { forwardRef, type SVGProps } from "react";
import { cn } from "../../lib/utils";

interface StopIconProps extends SVGProps<SVGSVGElement> {
  /** Pixel size; defaults to DuBois standard 16. */
  size?: number | string;
  className?: string;
  /** When set, the icon gets `role="img"`. */
  ariaLabel?: string;
}

export const StopIcon = forwardRef<SVGSVGElement, StopIconProps>(
  ({ size = 16, className, ariaLabel, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden={!ariaLabel}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      {...props}
    >
      <path
        fill="currentColor"
        d="M4.5 4a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5z"
      />
    </svg>
  ),
);
StopIcon.displayName = "StopIcon";
