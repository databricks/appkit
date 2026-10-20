import { Component, type ComponentType, type ReactNode } from "react";

/** Props for {@link DesignCanvas}. */
export interface DesignCanvasProps {
  /** `import.meta.glob` result: module path → module exports. */
  modules: Record<string, Record<string, unknown>>;
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

/**
 * Renders every PascalCase export of every module under `client/src/design/`
 * with no props, one frame each. Drafts and previews (real components wrapped
 * with mock data) are both just zero-prop components in that folder.
 *
 * Served by the `design()` plugin at `/design` in development.
 */
export function DesignCanvas({ modules }: DesignCanvasProps) {
  const frames = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, mod]) =>
      Object.entries(mod)
        .filter(([name, value]) => /^[A-Z]/.test(name) && isComponent(value))
        .map(([name, value]) => ({
          id: `${file}#${name}`,
          label: `${file.replace(/^\/src\/design\//, "")} · ${name}`,
          Frame: value as ComponentType,
        })),
    );

  return (
    <div className="min-h-screen bg-muted/40 p-8">
      <h1 className="mb-6 text-lg font-semibold">Design canvas</h1>
      {frames.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No designs yet. Export components from files in{" "}
          <code>client/src/design/</code> and they show up here.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {frames.map(({ id, label, Frame }) => (
            <section key={id}>
              <h2 className="text-muted-foreground mb-2 font-mono text-xs">
                {label}
              </h2>
              <div className="bg-background rounded-lg border p-6">
                <Boundary>
                  <Frame />
                </Boundary>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
