import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { Component, type ReactNode, Suspense, lazy } from "react";
import {
  createBrowserRouter,
  Link,
  RouterProvider,
  useParams,
} from "react-router";

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

function DraftPage() {
  const { name = "" } = useParams();
  const Page = pages[name];
  if (!Page)
    return (
      <div className="p-6 text-muted-foreground">
        No compiled draft named "{name}" yet.
      </div>
    );
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

function Index() {
  return (
    <div className="min-h-screen bg-background p-8">
      <Card className="max-w-xl mx-auto">
        <CardHeader>
          <CardTitle>Compiled drafts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Object.keys(pages).length === 0 && (
            <p className="text-muted-foreground">None yet.</p>
          )}
          {Object.keys(pages).map((name) => (
            <Link
              key={name}
              to={`/design/${name}`}
              className="block text-primary underline"
            >
              /design/{name}
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/", element: <Index /> },
  { path: "/design/:name", element: <DraftPage /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
