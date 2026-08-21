import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import {
  Children,
  type ComponentProps,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useMemo,
  useState,
} from "react";

import { cn } from "../lib/utils";
import { Variant, type VariantProps } from "./variant";

/** Endpoint the recorder plugin (`uiVariants()`) mounts in development. */
const CONFIRM_ENDPOINT = "/api/ui-variants/confirm";

/** Abort the confirm request after this long so the button can't hang. */
const CONFIRM_TIMEOUT_MS = 5000;

/**
 * Default switcher accent — a violet chosen to stand apart from most apps'
 * `primary`, so the dev-only picker chrome doesn't blend into the content it
 * wraps. Override per-block via the `accent` prop.
 */
const DEFAULT_ACCENT = "#8b5cf6";

type ConfirmState = "idle" | "saving" | "recorded" | "unavailable" | "error";

/** Props for {@link Variants}. */
export interface VariantsProps {
  /**
   * Stable, unique identifier for this block. The variant-picking agent matches
   * on it to finalize the chosen variant into source, so it must be unique per
   * file. (Named `blockId`, not `id`, because it is a semantic key — not a DOM
   * element id.)
   */
  blockId: string;
  /** `<Variant>` children — one candidate UI each. */
  children: ReactNode;
  /**
   * How the wrapper flows in the layout. Defaults to `"block"` (full width,
   * variants stack vertically) — the right choice for page sections, heroes,
   * and other block-level regions, which is the common case. Use `"inline"`
   * when wrapping a small inline element such as a single button, so the
   * wrapper hugs its content instead of spanning the row.
   */
  layout?: "block" | "inline";
  /** Class name applied to the block wrapper (merged after `layout`). */
  className?: string;
  /**
   * Any CSS color for the switcher chrome (dot, ring, control cluster, count
   * pill, confirm tick). Every accent element derives from this one value.
   * Defaults to {@link DEFAULT_ACCENT}. The error state stays red regardless.
   *
   * @example accent="var(--primary)"   // match the app theme
   * @example accent="#f43f5e"          // rose
   */
  accent?: string;
}

function isVariantElement(node: ReactNode): node is ReactElement<VariantProps> {
  return isValidElement(node) && node.type === Variant;
}

/**
 * Dev-time UI picker: renders several `<Variant>` candidates one at a time.
 *
 * At rest the block shows a small, slowly-pulsing corner dot so it's clear
 * it's "in variant state" without hovering — the dot pulses while a choice is
 * still pending and goes calm once recorded. On hover (or focus) an accent
 * ring outlines the block and the dot gives way to a compact control cluster
 * (‹ index/total › ✓) that scales out of the corner. Confirming POSTs the
 * choice to the `uiVariants()` recorder plugin; a coding agent then finalizes
 * the chosen variant into source, removing this wrapper.
 *
 * All switcher chrome uses the `accent` color (default {@link DEFAULT_ACCENT},
 * a violet distinct from most apps' `primary`) so it doesn't blend into the
 * content it wraps.
 *
 * Degrades gracefully. In a production build the picker chrome is dropped
 * entirely and only the first variant renders as plain content — a safety net
 * for a block that shipped without being finalized. In dev, if the recorder
 * endpoint is absent (feature off) the switcher still works as a viewer and
 * Confirm reports that recording is unavailable.
 *
 * @example Page section (default layout — full-width, stacks vertically)
 * ```tsx
 * <Variants blockId="hero">
 *   <Variant label="Split"><section>…</section></Variant>
 *   <Variant label="Centered"><section>…</section></Variant>
 * </Variants>
 * ```
 *
 * @example Small inline element (hug the content)
 * ```tsx
 * <Variants blockId="hero-cta" layout="inline">
 *   <Variant label="Ghost"><Button variant="ghost">Get started</Button></Variant>
 *   <Variant label="Solid"><Button>Get started</Button></Variant>
 * </Variants>
 * ```
 *
 * @example Custom accent
 * ```tsx
 * <Variants blockId="hero" accent="#f43f5e">…</Variants>
 * ```
 */
export function Variants({
  blockId,
  children,
  layout = "block",
  className,
  accent = DEFAULT_ACCENT,
}: VariantsProps) {
  const variants = useMemo(
    () => Children.toArray(children).filter(isVariantElement),
    [children],
  );
  const [active, setActive] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");

  if (variants.length === 0) return null;
  if (!import.meta.env.DEV) return <>{variants[0]}</>;

  const clampedActive = Math.min(active, variants.length - 1);
  const current = variants[clampedActive];
  const label = current.props.label ?? `Variant ${clampedActive + 1}`;
  const atStart = clampedActive === 0;
  const atEnd = clampedActive === variants.length - 1;

  const go = (delta: number) => {
    // No wrap-around: clamp within bounds.
    setActive((i) => Math.max(0, Math.min(variants.length - 1, i + delta)));
    setConfirmState("idle");
  };

  const confirm = async () => {
    if (confirmState === "saving") return;
    setConfirmState("saving");

    // Bound the request so a hung recorder can't leave the button stuck in
    // "saving" forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      const res = await fetch(CONFIRM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, chosenIndex: clampedActive, label }),
        signal: controller.signal,
      });
      // 404/403: the recorder isn't mounted (feature off or a production
      // build). Degrade to a plain viewer.
      if (res.status === 404 || res.status === 403) {
        setConfirmState("unavailable");
        return;
      }
      // Any other non-OK status (e.g. a 500) is a failure the user can retry.
      setConfirmState(res.ok ? "recorded" : "error");
    } catch {
      // Network failure or timeout abort — the request never completed.
      setConfirmState("error");
    } finally {
      clearTimeout(timeout);
    }
  };

  return (
    <div
      data-slot="variants"
      // All accent chrome derives from this one variable; children read it via
      // the cascade, so the `accent` prop flows everywhere without prop-drilling.
      style={{ "--variants-accent": accent } as CSSProperties}
      className={cn(
        // Ring appears only on hover/focus so blocks stay calm at rest; the
        // corner dot is the resting "in variant state" indicator.
        "group relative rounded-md ring-[color:var(--variants-accent)] transition-[box-shadow] duration-200",
        layout === "inline" ? "inline-block" : "block w-full",
        "hover:ring-1 focus-within:ring-1",
        className,
      )}
    >
      {current}

      <StateDot
        state={confirmState}
        className="group-hover:pointer-events-none group-hover:opacity-0 group-focus-within:pointer-events-none group-focus-within:opacity-0"
      />

      <div
        data-slot="variants-switcher"
        className={cn(
          "absolute -top-3 right-0 z-20 flex items-center gap-0.5 rounded-full border bg-background/95 px-1 py-0.5 shadow-md backdrop-blur",
          "border-[color-mix(in_srgb,var(--variants-accent)_40%,transparent)]",
          "pointer-events-none origin-top-right scale-90 opacity-0 transition-all duration-150",
          "group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100",
          "group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-100",
        )}
      >
        <RoundButton
          aria-label="Previous variant"
          disabled={atStart}
          onClick={() => go(-1)}
        >
          <ChevronLeft className="size-3.5" />
        </RoundButton>

        <span className="select-none rounded-full bg-[color-mix(in_srgb,var(--variants-accent)_15%,transparent)] px-1 text-[10px] font-semibold text-[color:var(--variants-accent)] tabular-nums">
          {clampedActive + 1}/{variants.length}
        </span>

        <RoundButton
          aria-label="Next variant"
          disabled={atEnd}
          onClick={() => go(1)}
        >
          <ChevronRight className="size-3.5" />
        </RoundButton>

        <ConfirmButton state={confirmState} label={label} onClick={confirm} />
      </div>
    </div>
  );
}

function dotColorFor(state: ConfirmState): string {
  switch (state) {
    case "error":
      return "bg-destructive";
    case "unavailable":
      return "bg-muted-foreground/40";
    default:
      return "bg-[color:var(--variants-accent)]";
  }
}

/**
 * Resting corner indicator: pulses while a choice is pending, calm once
 * recorded — so a block's picked/unpicked state reads at a glance without
 * hovering.
 */
function StateDot({
  state,
  className,
}: {
  state: ConfirmState;
  className?: string;
}) {
  const pulsing = state === "idle" || state === "saving";
  const color = dotColorFor(state);

  return (
    <span
      aria-hidden
      data-slot="variants-dot"
      className={cn(
        "absolute -top-1 -right-1 z-10 flex size-3 items-center justify-center transition-opacity duration-150",
        className,
      )}
    >
      {pulsing && (
        <span
          className={cn(
            // Slow, gentle pulse (~2.5s) so it reads as an ambient hint,
            // not an alarm. Overrides tailwind's default 1s ping cadence.
            "absolute inline-flex size-full animate-ping rounded-full opacity-50 [animation-duration:2.5s]",
            color,
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full ring-2 ring-background",
          color,
        )}
      />
    </span>
  );
}

function RoundButton({
  children,
  disabled,
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "disabled:pointer-events-none disabled:opacity-30",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Round tick that confirms the active variant. State is conveyed by icon +
 * color only (no text). The chosen `label` rides along in the title/aria for
 * accessibility and hover context.
 */
function ConfirmButton({
  state,
  label,
  onClick,
}: {
  state: ConfirmState;
  label: string;
  onClick: () => void;
}) {
  const title =
    state === "recorded"
      ? `Recorded "${label}" — ask the agent to finalize`
      : state === "unavailable"
        ? "Recorder unavailable"
        : state === "error"
          ? "Failed — click to retry"
          : `Confirm "${label}"`;

  return (
    <RoundButton
      aria-label={title}
      title={title}
      disabled={state === "saving" || state === "unavailable"}
      onClick={onClick}
      className={cn(
        state === "recorded" &&
          "text-[color:var(--variants-accent)] hover:bg-[color-mix(in_srgb,var(--variants-accent)_12%,transparent)] hover:text-[color:var(--variants-accent)]",
        state === "error" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive",
        (state === "idle" || state === "saving") &&
          "hover:bg-[color-mix(in_srgb,var(--variants-accent)_12%,transparent)] hover:text-[color:var(--variants-accent)]",
      )}
    >
      {state === "saving" ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : state === "recorded" ? (
        <CheckCheck className="size-3.5" />
      ) : (
        <Check className="size-3.5" />
      )}
    </RoundButton>
  );
}
