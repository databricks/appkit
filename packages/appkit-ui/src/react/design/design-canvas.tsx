import { LayoutTemplate, MousePointerClick } from "lucide-react";
import {
  Component,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { DesignPicker, useAboveModals } from "./design-picker";

/** Props for {@link DesignCanvas}. */
export interface DesignCanvasProps {
  /** `import.meta.glob` result: module path → module exports. */
  modules: Record<string, Record<string, unknown>>;
  /** Origins an embedding app builder may be on (the plugin's `builderOrigin`). */
  builderOrigins?: string[];
}

/** memo / forwardRef components are objects, not functions. */
const WRAPPED_COMPONENTS = new Set([
  Symbol.for("react.memo"),
  Symbol.for("react.forward_ref"),
]);

function isComponent(value: unknown): boolean {
  if (typeof value === "function") return true;
  return (
    typeof value === "object" &&
    value !== null &&
    WRAPPED_COMPONENTS.has((value as { $$typeof?: symbol }).$$typeof as symbol)
  );
}

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre className="text-destructive text-xs whitespace-pre-wrap">
          {this.state.error.message}
        </pre>
      );
    }
    return this.props.children;
  }
}

/** Dotted backdrop so frame content reads as "on the canvas". */
const CANVAS_BACKDROP = {
  backgroundImage:
    "radial-gradient(color-mix(in oklch, var(--border) 90%, transparent) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

/**
 * Renders every PascalCase export of every module under `client/src/design/`
 * with no props, one frame each, plus the element picker. Drafts and previews
 * (real components wrapped with mock data) are both just zero-prop components
 * in that folder.
 *
 * Served by the `design()` plugin at `/design` in development.
 */
export function DesignCanvas({ modules, builderOrigins }: DesignCanvasProps) {
  const [selecting, setSelecting] = useState(false);
  const onActiveChange = useCallback((v: boolean) => setSelecting(v), []);
  const headerRef = useRef<HTMLElement>(null);
  // The header (and its Select toggle) stays clickable over an open dialog,
  // so a dialog's contents can be selected after opening it.
  useAboveModals(headerRef);

  // Alt+S toggles selecting from the keyboard, e.g. while a dialog has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyS" || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      setSelecting((s) => !s);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const files = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, mod]) => ({
      file: path.replace(/^\/src\/design\//, ""),
      frames: Object.entries(mod)
        .filter(([name, value]) => /^[A-Z]/.test(name) && isComponent(value))
        .map(([name, value]) => ({
          id: `${path}#${name}`,
          name,
          Frame: value as ComponentType,
        })),
    }))
    .filter((f) => f.frames.length > 0);
  const count = files.reduce((n, f) => n + f.frames.length, 0);

  return (
    <div className="bg-muted/40 text-foreground min-h-screen">
      <header
        ref={headerRef}
        data-design-chrome
        className="bg-background/80 pointer-events-auto sticky top-0 z-[2147483646] flex h-14 items-center gap-3 border-b px-6 backdrop-blur"
      >
        <LayoutTemplate className="text-muted-foreground size-5" />
        <h1 className="text-sm font-semibold">Design canvas</h1>
        <Badge variant="secondary">
          {count} {count === 1 ? "frame" : "frames"}
        </Badge>
        <p className="text-muted-foreground ml-2 hidden text-xs md:block">
          Pick the parts you want changed and send them to your agent.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {selecting ? (
              <>
                <Kbd>Esc</Kbd> to stop
              </>
            ) : (
              <>
                <Kbd>Alt</Kbd> <Kbd>S</Kbd> to select
              </>
            )}
          </span>
          <Button
            size="sm"
            variant={selecting ? "default" : "outline"}
            aria-pressed={selecting}
            onClick={() => setSelecting((s) => !s)}
          >
            <MousePointerClick className="size-4" />
            {selecting ? "Selecting" : "Select"}
          </Button>
        </div>
      </header>

      {count === 0 ? (
        <Empty className="mx-auto mt-24 max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutTemplate />
            </EmptyMedia>
            <EmptyTitle>No designs yet</EmptyTitle>
            <EmptyDescription>
              Export components from files in <code>client/src/design/</code>{" "}
              and they show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mx-auto flex max-w-7xl gap-8 px-6 py-8">
          <nav
            data-design-chrome
            className="sticky top-22 hidden h-fit w-52 shrink-0 flex-col gap-4 lg:flex"
          >
            {files.map(({ file, frames }) => (
              <div key={file} className="flex flex-col gap-1">
                <div className="text-muted-foreground px-2 font-mono text-[11px]">
                  {file}
                </div>
                {frames.map(({ id, name }) => (
                  <a
                    key={id}
                    href={`#${encodeURIComponent(id)}`}
                    className="hover:bg-accent hover:text-accent-foreground truncate rounded-md px-2 py-1 text-sm"
                  >
                    {name}
                  </a>
                ))}
              </div>
            ))}
          </nav>

          <main className="flex min-w-0 flex-1 flex-col gap-8">
            {files.flatMap(({ file, frames }) =>
              frames.map(({ id, name, Frame }) => (
                <section
                  key={id}
                  id={encodeURIComponent(id)}
                  className="bg-card scroll-mt-20 overflow-hidden rounded-xl border shadow-sm"
                >
                  <div
                    data-design-chrome
                    className="flex items-center gap-2 border-b px-4 py-2.5"
                  >
                    <h2 className="text-sm font-medium">{name}</h2>
                    <span className="text-muted-foreground font-mono text-xs">
                      {file}
                    </span>
                  </div>
                  <div className="p-8" style={CANVAS_BACKDROP}>
                    <Boundary>
                      <Frame />
                    </Boundary>
                  </div>
                </section>
              )),
            )}
          </main>
        </div>
      )}

      <DesignPicker
        active={selecting}
        onActiveChange={onActiveChange}
        builderOrigins={builderOrigins}
      />
    </div>
  );
}
