import { Component, type ReactNode, Suspense, lazy } from "react";
import { useParams } from "react-router";

// Drafts land here only after they type-check, so every module in the glob compiles.
const modules = import.meta.glob<{ default: React.ComponentType }>(
  "./design/pages/*.tsx",
);
const pages = Object.fromEntries(
  Object.entries(modules).map(([file, load]) => [
    file.replace("./design/pages/", "").replace(".tsx", ""),
    lazy(load),
  ]),
);

class DraftBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div data-draft-error className="p-6 text-destructive">
          Draft crashed: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export function DraftPage() {
  const { name = "" } = useParams();
  const Page = pages[name];
  if (!Page) {
    return (
      <div className="p-6 text-muted-foreground">
        No compiled draft named "{name}" yet.
      </div>
    );
  }
  return (
    <DraftBoundary key={name}>
      <Suspense fallback={null}>
        <div
          data-draft-ready
          className="min-h-screen bg-background text-foreground"
        >
          <Page />
        </div>
      </Suspense>
    </DraftBoundary>
  );
}
